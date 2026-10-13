// too-long side pane: shows a plan's progress, stages, tasks, decisions, risks and files beside the
// transcript, opened when a plan is approved or by /too-long-pane. Ticking a task writes [x] into
// the Markdown. All the work is done by scripts/pane.py (the same core as the website); this file
// only decides when to call it and draws what it prints.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsStat, Register, RenderElement, Timer } from 'claude-code'

import type { PaneDoc, PaneView, PlanFile, PlanMode, Tab, Task } from '../types'

const PANE = 'too-long'
const USAGE = 'Usage: /too-long-pane <path-to-plan.md>'
const TICK_MS = 1000
const MAX_ROWS = 200
const NO_PYTHON = 'too-long needs Python 3.9+ on PATH (tried python3, python). Install it, then run /too-long-pane again.'
const TABS: [Tab, string][] = [['roadmap', 'Roadmap'], ['tasks', 'Tasks'], ['highlights', 'Decisions'], ['files', 'Files']]

const EMPTY: PaneView = { status: 'idle', path: '', doc: null, error: '', notice: '', pending: '', tab: 'roadmap', showDone: false }
const view = atom({ plugin: 'too-long-pane', key: 'view' } as const, EMPTY)
const plan = atom({ plugin: 'too-long-pane', key: 'plan' } as const, { path: '' } as PlanMode)

type Result = { status: string; error?: string; revision?: string; [k: string]: unknown }

// Module state: lost on a reload, which also drops the timers (session.start starts them again).
type Watch = { path: string; timer: Timer | null; lastSig: string; builtSig: string; building: Promise<void> | null; isDirty: boolean }
let watch: Watch | null = null
let isWriting = false
let python: string | null = null
// The live site of the plan shown (serve.py): started by the first "Open full site", kept until
// another plan is shown or the session ends; a reload of the mod ends it with the module.
type Server = { path: string; url: Promise<string | null>; found: (url: string | null) => void; stop: () => void }
let server: Server | null = null

// ---- running pane.py ----

async function findPython($: EngineInterface): Promise<string | null> {
  if (python) return python
  for (const exe of ['python3', 'python']) {
    try {
      const r = await $.process.run([exe, '-c', 'import sys; sys.exit(sys.version_info < (3, 9))'], { timeoutMs: 10_000 })
      if (r.exitCode === 0) return (python = exe)
    } catch {
      // not on PATH: try the next name
    }
  }
  return null
}

async function runPane($: EngineInterface, args: string[]): Promise<Result> {
  const exe = await findPython($)
  if (!exe) return { status: 'error', error: NO_PYTHON }
  let r
  try {
    r = await $.process.run([exe, `${$.plugin.root}/scripts/pane.py`, ...args], { timeoutMs: 120_000 })
  } catch (err) {
    return { status: 'error', error: `could not run too-long: ${String(err)}` }
  }
  try {
    const out = JSON.parse(r.stdout)
    if (out && typeof out.status === 'string') return out
  } catch {
    // fall through: not our JSON
  }
  const last = r.stderr.trim().split('\n').pop()
  return { status: 'error', error: `too-long failed: ${last || `exit code ${r.exitCode}`}` }
}

function isDoc(r: Result): boolean {
  return r.status === 'ok' && typeof r.revision === 'string' && Array.isArray(r.tasks) && Array.isArray(r.stages)
}

// ---- state ----

async function patch($: EngineInterface, fn: (v: PaneView) => PaneView) {
  // Only write when something changed: every write redraws the pane.
  const v = await read($, view)
  if (fn(v) !== v) await update($, view, fn)
}

async function setNotice($: EngineInterface, path: string, notice: string) {
  await patch($, v => (v.path !== path || v.notice === notice ? v : { ...v, notice }))
}

async function apply($: EngineInterface, path: string, r: Result) {
  await patch($, v => {
    if (v.path !== path) return v
    if (isDoc(r)) {
      if (v.status === 'ready' && !v.notice && v.doc?.revision === r.revision) return v
      return { ...v, status: 'ready', doc: r as unknown as PaneDoc, error: '', notice: '' }
    }
    const why = r.error || `unexpected answer: ${r.status}`
    if (v.doc) return { ...v, notice: `Unable to refresh plan, showing last known state. (${why})` }
    return { ...v, status: 'error', error: why }
  })
}

// ---- watching the plan ----

async function statFile($: EngineInterface, path: string): Promise<FsStat | null> {
  try {
    const s = await $.fs.stat(path, { resolve: true })
    return s.kind === 'file' ? s : null
  } catch {
    return null
  }
}

function sigOf(s: FsStat | null): string {
  return s ? `${s.mtimeMs}:${s.size}` : ''
}

// One build at a time; a change seen during a build (or asked for meanwhile) builds again after it.
async function refresh($: EngineInterface, w: Watch): Promise<void> {
  if (w.building) {
    w.isDirty = true
    return w.building
  }
  w.building = (async () => {
    do {
      w.isDirty = false
      const before = sigOf(await statFile($, w.path))
      const r = await runPane($, ['model', w.path, '--root', await $.session.root()])
      if (watch !== w) return
      if (sigOf(await statFile($, w.path)) !== before) w.isDirty = true
      else w.builtSig = before
      await apply($, w.path, r)
    } while (w.isDirty && watch === w)
  })().finally(() => {
    w.building = null
  })
  return w.building
}

// Every second: rebuild once the file changed and then stayed the same for a tick (debounce).
async function tick($: EngineInterface, w: Watch) {
  if (watch !== w || isWriting) return
  const s = await statFile($, w.path)
  if (!s) {
    w.lastSig = ''
    return setNotice($, w.path, `Plan file not found: ${w.path}. Showing last known state.`)
  }
  const sig = sigOf(s)
  const isSettled = sig === w.lastSig
  w.lastSig = sig
  if (isSettled && sig !== w.builtSig) await refresh($, w)
}

function stopWatching() {
  watch?.timer?.cancel()
  watch = null
}

async function startWatching($: EngineInterface, path: string) {
  if (watch?.path === path) return
  stopWatching()
  if (server && server.path !== path) stopServer()
  const w: Watch = { path, timer: null, lastSig: '', builtSig: '', building: null, isDirty: false }
  watch = w
  w.timer = $.clock.every(TICK_MS, () => void tick($, w))
  await refresh($, w)
}

// ---- opening a plan ----

async function storeKey($: EngineInterface): Promise<string> {
  return `last-plan:${await $.session.root()}`
}

async function expandPath($: EngineInterface, path: string): Promise<string> {
  const p = path.trim().replace(/^(["'])(.*)\1$/, '$2')
  if (p === '~' || p.startsWith('~/')) return `${(await $.env.get('HOME')) ?? '~'}${p.slice(1)}`
  return p
}

// Shows the plan in the pane. `isAsked`: the person's command (the pane is placed at any width);
// otherwise an approval opened it, and a pane the surface did not place gets a toast instead.
async function show($: EngineInterface, path: string, isAsked: boolean): Promise<string> {
  const s = await statFile($, path)
  if (!s) return `Plan not found: ${path}`
  const real = s.realPath ?? path
  await patch($, v => (v.path === real ? v : { ...EMPTY, tab: v.tab, status: 'loading', path: real }))
  await $.store.set(await storeKey($), real)
  const opened = await $.ui.open({ id: PANE, title: 'too-long' })
  if (!opened.isPlaced && !isAsked) $.ui.toast('too-long: plan ready. Run /too-long-pane to open it.')
  // The first build runs on a timer, outside the hook that asked for it.
  $.clock.after(0, () => void startWatching($, real))
  return `Showing ${real} in the too-long pane.`
}

// ---- task writes ----

async function toggle($: EngineInterface, task: Task, revision: string) {
  const w = watch
  if (!w) return
  if (isWriting) {
    $.ui.toast('too-long: saving the previous change...')
    return
  }
  isWriting = true
  await patch($, v => ({ ...v, pending: task.id }))
  try {
    if (w.building) await w.building // never write while a build reads the file
    // The revision the person saw: if the plan changed since, sync refuses and nothing is written.
    const r = await runPane($, ['task', w.path, task.id, task.done ? '--undo' : '--done', '--revision', revision])
    if (r.status === 'conflict') $.ui.toast('Plan changed outside the pane. Refreshed; press again if still needed.')
    else if (r.status === 'busy') $.ui.toast('Plan is being saved by another process. Try again.')
    else if (r.status === 'not_found') $.ui.toast('That task is no longer in the plan. Refreshed.')
    else if (r.status !== 'applied') $.ui.toast(`too-long: ${r.error ?? r.status}`)
    if (r.status !== 'busy' && r.status !== 'error') await refresh($, w)
  } finally {
    isWriting = false
    await patch($, v => (v.pending ? { ...v, pending: '' } : v))
  }
}

function stopServer() {
  server?.stop()
  server = null
}

// Runs `pane.py serve` for as long as the loop reads it; the first line it prints says where.
async function runServer($: EngineInterface, s: Server) {
  const exe = await findPython($)
  if (!exe || server !== s) return s.found(null)
  const stream = $.process.spawn({ argv: [exe, `${$.plugin.root}/scripts/pane.py`, 'serve', s.path, '--root', await $.session.root()] })
  s.stop = () => void stream.return(undefined as never)
  let first = ''
  try {
    for await (const chunk of stream) {
      if (chunk.stream !== 'stdout' || first.includes('\n')) continue
      first += chunk.text
      if (!first.includes('\n')) continue
      try {
        const out = JSON.parse(first.split('\n')[0] ?? '')
        s.found(out.status === 'serving' && typeof out.url === 'string' ? out.url : null)
      } catch {
        s.found(null)
      }
    }
  } catch {
    // could not start: answered below
  }
  s.found(null) // a no-op once the URL was found
  if (server === s) server = null
}

// Opens the live site: browser ticks are written to the plan and plan edits reload the page.
// Without a server it falls back to the static file (ticks there stay in the browser).
async function openSite($: EngineInterface, path: string) {
  if (server?.path !== path) {
    stopServer()
    let found: (url: string | null) => void = () => {}
    const url = new Promise<string | null>(resolve => (found = resolve))
    const s: Server = { path, url, found, stop: () => {} }
    server = s
    $.clock.after(0, () => void runServer($, s)) // outside the press, so the server outlives it
  }
  const url = await server.url
  const r = await runPane($, ['open', path, ...(url ? ['--url', url] : [])])
  if (r.status !== 'ok') $.ui.toast(`too-long: ${r.error ?? 'could not open the site'}`)
  else if (!url) $.ui.toast('too-long: the live site did not start; opened the static copy (its ticks stay in the browser).')
}

// ---- plan mode ----

async function remember($: EngineInterface, path: string) {
  if ((await read($, plan)).path !== path) await update($, plan, () => ({ path }))
}

// The plan was approved (ExitPlanMode succeeded): open the file this planning wrote.
async function approved($: EngineInterface) {
  const { path } = await read($, plan)
  if (!path) {
    $.ui.toast(`Plan approved. ${USAGE}`)
    return
  }
  await show($, path, false)
}

// ---- drawing ----

const ACCENT = '#3fb27f'

// A rounded progress bar for surfaces that draw SVG; the terminal gets text.
function barSvg(done: number, total: number, width: number, height = 6): string {
  const w = total ? Math.round((done / total) * width) : 0
  const r = height / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" rx="${r}" fill="#8884"/>`
    + (w ? `<rect width="${Math.max(w, height)}" height="${height}" rx="${r}" fill="${ACCENT}"/>` : '')
    + '</svg>'
}

// The header's progress ring, its percentage in the accent color (readable on light and dark).
function ringSvg(done: number, total: number): string {
  const c = 2 * Math.PI * 19
  const pct = total ? Math.round((done / total) * 100) : 0
  return '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">'
    + '<circle cx="24" cy="24" r="19" fill="none" stroke="#8884" stroke-width="5"/>'
    + (pct ? `<circle cx="24" cy="24" r="19" fill="none" stroke="${ACCENT}" stroke-width="5" stroke-linecap="round"`
      + ` stroke-dasharray="${(c * pct) / 100} ${c}" transform="rotate(-90 24 24)"/>` : '')
    + `<text x="24" y="28" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="${ACCENT}">${pct}%</text>`
    + '</svg>'
}

function barText(done: number, total: number, width: number): string {
  const n = total ? Math.round((done / total) * width) : 0
  return '━'.repeat(n) + '─'.repeat(width - n)
}

function stageMark(done: number, total: number): [string, string] {
  if (total > 0 && done === total) return ['●', 'success']
  return done > 0 ? ['◐', 'warning'] : ['○', 'subtle']
}

// Task text as written, minus the Markdown code ticks the pane cannot draw.
function plain(text: string): string {
  return text.replace(/`/g, '')
}

const KINDS = [['decision', 'Decisions', 'Decision', 'suggestion'], ['risk', 'Risks', 'Risk', 'warning'], ['question', 'Open questions', 'Question', 'permission']] as const
const FILE_MARK = { exists: ['●', 'success'], planned: ['○', 'subtle'], ambiguous: ['?', 'warning'] } as const

type TreeNode = { children: Map<string, TreeNode>; status?: PlanFile['status']; isDir: boolean }
type TreeRow = { path: string; name: string; depth: number; isDir: boolean; status?: PlanFile['status'] }

// The mentioned paths as a folder tree: folders first, then files, by name. A folder whose only
// child is a folder, and that is not mentioned itself, shares its row ("~/.claude/plans/"). Paths
// outside the project (~/, /) come last.
function fileTree(files: PlanFile[]): TreeRow[] {
  const root: TreeNode = { children: new Map(), isDir: true }
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean)
    if (f.path.startsWith('/') && parts.length) parts[0] = `/${parts[0]}`
    let node = root
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1
      let child = node.children.get(part)
      if (!child) node.children.set(part, (child = { children: new Map(), isDir: !isLast || f.path.endsWith('/') }))
      if (!isLast) child.isDir = true
      else child.status = f.status
      node = child
    })
  }
  const rows: TreeRow[] = []
  const walk = (node: TreeNode, depth: number, prefix: string) => {
    const outside = (name: string) => Number(depth === 0 && /^[~/]/.test(name)) // ~/ and / paths after the project's
    const entries = [...node.children].sort(([a, x], [b, y]) =>
      outside(a) - outside(b) || Number(y.isDir) - Number(x.isDir) || a.localeCompare(b))
    for (const [part, child] of entries) {
      let name = part
      let n = child
      while (n.isDir && !n.status && n.children.size === 1) {
        const [[next, only]] = [...n.children] as [[string, TreeNode]]
        if (!only.isDir) break
        name += `/${next}`
        n = only
      }
      const path = `${prefix}${name}${n.isDir ? '/' : ''}`
      rows.push({ path, name: n.isDir ? `${name}/` : name, depth, isDir: n.isDir, status: n.status })
      walk(n, depth + 1, path)
    }
  }
  walk(root, 0, '')
  return rows
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'too-long-pane', description: 'Show a Markdown plan in the too-long side pane', argumentHint: '[path-to-plan.md]' })
    // After a reload the pane may still be open: watch its plan again (the old timer is gone).
    const v = await read($, view)
    if (v.path && (await $.ui.panes()).some(p => p.id === PANE)) $.clock.after(0, () => void startWatching($, v.path))
    return next(e)
  })

  on('session.end', ($, e, next) => {
    stopWatching()
    stopServer()
    return next(e)
  })

  on('command.run', { command: 'too-long-pane' }, async ($, e) => {
    const asked = await expandPath($, e.args)
    const path = asked || (await read($, plan)).path || String((await $.store.get(await storeKey($))) ?? '')
    if (!path) return { text: USAGE }
    return { text: await show($, path, true) }
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    stopWatching()
    return next(e)
  }).catch(($, e, next) => next(e))

  // Which file the plan is written to. These notes only remember the path: the engine renders
  // them again for old rows (when a mod loads, say), so they never open anything.
  for (const type of ['plan_mode', 'plan_mode_reentry', 'plan_mode_exit'] as const) {
    on('prompt.attachment', { type }, async ($, e, next) => {
      const path = e.detail?.planFilePath
      if (path) await remember($, path)
      return next(e)
    })
  }

  // Approval: the ExitPlanMode call itself, which happens once and is never replayed.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const r = await next(e)
    if (r.result !== undefined && !r.isError) $.clock.after(0, () => void approved($)) // not a deny or a rejection
    return r
  }).catch(($, e, next) => next(e)) // never in the way of the tool call

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
    const v = await read($, view)
    const cols = Math.max(20, e.props.bodyColumns)
    const doc = v.doc

    if (!doc) {
      const msg =
        v.status === 'loading' ? `Building the view of ${v.path}...`
        : v.status === 'error' ? `Couldn't show ${v.path}: ${v.error}`
        : `No plan open. ${USAGE}`
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text color={v.status === 'error' ? 'error' : undefined} dimColor={v.status !== 'error'} wrap="wrap">{msg}</Text>
        </Box>
      )
    }

    const checkable = doc.tasks.filter(t => !t.browser_only)
    const done = checkable.filter(t => t.done).length
    const titles = new Map([...doc.sections, ...doc.stages].map(s => [s.id, s.title] as const))
    const inner = Math.max(80, Math.min((cols - 6) * 8, 440)) // px inside a card
    const body: RenderElement[] = []
    let shown = 0

    // Progress as a thin bar: SVG where the surface draws it, text in the terminal.
    const bar = (key: string, d: number, t: number, width: number, height = 4) =>
      Svg
        ? <Svg key={key} source={barSvg(d, t, width, height)} alt={`${d} of ${t} done`} />
        : <Text key={key} color="success">{barText(d, t, Math.max(8, Math.min(30, cols - 8)))}</Text>

    const card = (key: string, children: RenderElement[], color?: string) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={!color}
        paddingX={1} marginTop={body.length ? 1 : 0}>
        {children}
      </Box>
    )

    const cardHead = (key: string, title: string, extra = '') => (
      <Box key={key} flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text bold wrap="truncate-end">{title}</Text>
        {extra ? <Text dimColor>{extra}</Text> : null}
      </Box>
    )

    const taskRow = (t: Task) => {
      if (t.browser_only) return <Text key={`t:${t.id}`} dimColor wrap="wrap">{`·  ${plain(t.text)}  (site only)`}</Text>
      const isPending = v.pending === t.id
      return (
        <Box key={`row:${t.id}`} hover={{ backgroundColor: 'subtle' }}>
          <Button key={`t:${t.id}`} plain dimColor={!!v.pending && !isPending} onPress={() => void toggle($, t, doc.revision)}>
            <Text color={t.done ? 'success' : 'subtle'}>{isPending ? '◌' : t.done ? '☑' : '☐'}</Text>
            {'  '}
            <Text dimColor={t.done} strikethrough={t.done}>{plain(t.text)}</Text>
          </Button>
        </Box>
      )
    }

    // Where the work is: the first unfinished stage, else wherever the first open task is.
    const stages = doc.stages.filter(s => s.total > 0) // a design doc's task-less sections say nothing
    const current = stages.find(s => s.done < s.total)
    const firstOpen = doc.tasks.find(t => !t.done && !t.browser_only)
    const where = current?.id ?? firstOpen?.section

    if (v.tab === 'roadmap') {
      if (where) {
        const open = doc.tasks.filter(t => !t.done && (t.section === where || t.at === where)).slice(0, 3)
        body.push(card('next', [
          <Text key="next-label" color="claude" bold>NEXT UP</Text>,
          <Text key="next-title" bold wrap="wrap">{titles.get(where) ?? where}</Text>,
          <Box key="next-tasks" flexDirection="column" marginTop={1}>{open.map(taskRow)}</Box>,
        ], 'claude'))
      } else {
        body.push(<Text key="none" color={checkable.length ? 'success' : undefined} dimColor={!checkable.length}>
          {checkable.length ? 'All tasks are done.' : 'No tasks in this plan.'}
        </Text>)
      }
      if (stages.length) {
        body.push(card('stages', stages.flatMap(s => {
          const [mark, color] = stageMark(s.done, s.total)
          return [
            <Box key={`s:${s.id}`} flexDirection="row" justifyContent="space-between" columnGap={1} marginTop={1}>
              <Text wrap="truncate-end" bold={s.id === current?.id}><Text color={color}>{mark}</Text>{`  ${s.title}`}</Text>
              <Text dimColor>{`${s.done}/${s.total}`}</Text>
            </Box>,
            bar(`sb:${s.id}`, s.done, s.total, inner, 4),
          ]
        })))
      }
    } else if (v.tab === 'tasks') {
      if (!doc.tasks.length) body.push(<Text key="none" dimColor>No tasks in this plan.</Text>)
      const groups = new Map<string, Task[]>()
      for (const t of doc.tasks) groups.set(t.section, [...(groups.get(t.section) ?? []), t])
      for (const [section, list] of groups) {
        const visible = list.filter(t => v.showDone || !t.done).filter(() => shown++ < MAX_ROWS)
        const d = list.filter(t => t.done).length
        body.push(card(`g:${section}`, [
          cardHead(`gh:${section}`, titles.get(section) ?? section, `${d}/${list.length}`),
          bar(`gb:${section}`, d, list.length, inner, 4),
          ...(visible.length
            ? [<Box key={`gt:${section}`} flexDirection="column" marginTop={1}>{visible.map(taskRow)}</Box>]
            : [<Text key={`gd:${section}`} dimColor>{`All ${list.length} done`}</Text>]),
        ]))
      }
      if (shown > MAX_ROWS) body.push(<Text key="more" dimColor>{`${shown - MAX_ROWS} more in the full site.`}</Text>)
      const doneCount = doc.tasks.filter(t => t.done).length
      if (doneCount) {
        body.push(
          <Box key="show-done-row" marginTop={1}>
            <Button key="show-done" plain dimColor onPress={() => void update($, view, x => ({ ...x, showDone: !x.showDone }))}>
              {v.showDone ? 'Hide done tasks' : `Show ${doneCount} done`}
            </Button>
          </Box>,
        )
      }
    } else if (v.tab === 'highlights') {
      if (!doc.highlights.length) body.push(<Text key="none" dimColor>No decisions, risks or questions found.</Text>)
      for (const [kind, , label, color] of KINDS) {
        doc.highlights.filter(item => item.kind === kind).forEach((item, i) => { // not `h`: the JSX factory
          body.push(card(`h:${kind}:${i}`, [
            <Text key="kind" color={color} bold>{label.toUpperCase()}</Text>,
            <Text key="title" wrap="wrap">{plain(item.title)}</Text>,
            ...(item.mitigation ? [<Text key="mitigation" dimColor wrap="wrap">{`↳ ${plain(item.mitigation)}`}</Text>] : []),
          ], color))
        })
      }
    } else {
      if (!doc.files.length) body.push(<Text key="none" dimColor>No files mentioned.</Text>)
      else {
        const count = (status: PlanFile['status']) => doc.files.filter(f => f.status === status).length
        const unclear = count('ambiguous')
        body.push(card('files', [
          cardHead('h:files', 'Files', `${count('exists')} exist · ${count('planned')} to create${unclear ? ` · ${unclear} unclear` : ''}`),
          <Box key="tree" flexDirection="column" marginTop={1}>
            {fileTree(doc.files).slice(0, MAX_ROWS).map(row => {
              const [mark, color] = row.status ? FILE_MARK[row.status] : (['▾', 'subtle'] as const)
              return (
                <Box key={`f:${row.path}`} paddingLeft={row.depth * 2}>
                  <Text wrap="truncate-end">
                    <Text color={color}>{mark}</Text>
                    {'  '}
                    {row.isDir ? <Text bold={!row.status} dimColor={!row.status}>{row.name}</Text> : row.name}
                  </Text>
                </Box>
              )
            })}
          </Box>,
        ]))
      }
    }

    const now = where ? (titles.get(where) ?? where) : checkable.length ? 'All done' : 'No tasks'
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text bold wrap="wrap">{doc.title}</Text>
          <Box flexDirection="row" alignItems="center" columnGap={2} marginTop={1}>
            {Svg ? <Svg source={ringSvg(done, checkable.length)} alt={`${done} of ${checkable.length} tasks done`} /> : null}
            <Box flexDirection="column" flexShrink={1}>
              <Text bold>{`${done}/${checkable.length} tasks done`}</Text>
              <Text dimColor wrap="truncate-end">{now}</Text>
              {Svg ? null : bar('bar', done, checkable.length, inner)}
            </Box>
          </Box>
        </Box>
        {v.notice ? <Box key="notice" marginTop={1}><Text color="warning" wrap="wrap">{`⚠ ${v.notice}`}</Text></Box> : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1} paddingX={1}>
          {TABS.map(([id, label], i) => (
            <Button key={`tab:${id}`} plain hotkey={e.surface === 'terminal' ? String(i + 1) : undefined}
              onPress={() => void update($, view, x => ({ ...x, tab: id }))}>
              {v.tab === id ? <Text bold color="claude">{label}</Text> : <Text dimColor>{label}</Text>}
            </Button>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>{body}</Box>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={1} marginTop={1}>
          <Button key="open-site" variant="primary" onPress={() => void openSite($, doc.path)}>Open full site ↗</Button>
          <Text dimColor wrap="truncate-start">{doc.file}</Text>
        </Box>
      </Box>
    )
  })
}
