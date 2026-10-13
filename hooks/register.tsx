// too-long side pane: shows a plan's progress, stages, tasks, decisions, risks and files beside the
// transcript, opened when a plan is approved or by /too-long-pane. Ticking a task writes [x] into
// the Markdown. All the work is done by scripts/pane.py (the same core as the website); this file
// only decides when to call it and draws what it prints.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsStat, Register, RenderElement, Timer } from 'claude-code'

import type { PaneDoc, PaneView, PlanMode, Tab, Task } from '../types'

const PANE = 'too-long'
const USAGE = 'Usage: /too-long-pane <path-to-plan.md>'
const TICK_MS = 1000
const MAX_ROWS = 200
const NO_PYTHON = 'too-long needs Python 3.9+ on PATH (tried python3, python). Install it, then run /too-long-pane again.'
const TABS: [Tab, string][] = [['roadmap', 'Roadmap'], ['tasks', 'Tasks'], ['highlights', 'Decisions & risks'], ['files', 'Files']]

const EMPTY: PaneView = { status: 'idle', path: '', doc: null, error: '', notice: '', pending: '', tab: 'roadmap', showDone: false }
const view = atom({ plugin: 'too-long-pane', key: 'view' } as const, EMPTY)
const plan = atom({ plugin: 'too-long-pane', key: 'plan' } as const, { path: '', isArmed: false } as PlanMode)

type Result = { status: string; error?: string; revision?: string; [k: string]: unknown }

// Module state: lost on a reload, which also drops the timers (session.start starts them again).
type Watch = { path: string; timer: Timer | null; lastSig: string; builtSig: string; building: Promise<void> | null; isDirty: boolean }
let watch: Watch | null = null
let isWriting = false
let python: string | null = null

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

async function openSite($: EngineInterface, path: string) {
  const r = await runPane($, ['open', path])
  if (r.status !== 'ok') $.ui.toast(`too-long: ${r.error ?? 'could not open the site'}`)
}

// ---- plan mode ----

async function arm($: EngineInterface, path: string) {
  const p = await read($, plan)
  if (p.path !== path || !p.isArmed) await update($, plan, () => ({ path, isArmed: true }))
}

// Plan mode ended with a plan approved: open it once per planning.
async function approved($: EngineInterface, exitPath: string | null) {
  const p = await read($, plan)
  const path = exitPath ?? p.path
  if (!path) {
    $.ui.toast(`Plan approved. ${USAGE}`)
    return
  }
  if (!p.isArmed && path === p.path) return // this planning's approval already opened it
  await update($, plan, () => ({ path, isArmed: false }))
  await show($, path, false)
}

// ---- drawing ----

function bar(done: number, total: number, width: number): string {
  const n = total ? Math.round((done / total) * width) : 0
  return '▓'.repeat(n) + '░'.repeat(width - n)
}

function stageGlyph(done: number, total: number): string {
  return total > 0 && done === total ? '✓' : done > 0 ? '◐' : '○'
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

  // Planning: remember which file the plan is written to.
  on('prompt.attachment', { type: 'plan_mode' }, async ($, e, next) => {
    if (e.detail?.planFilePath) await arm($, e.detail.planFilePath)
    return next(e)
  })
  on('prompt.attachment', { type: 'plan_mode_reentry' }, async ($, e, next) => {
    if (e.detail?.planFilePath) await arm($, e.detail.planFilePath)
    return next(e)
  })

  // Approval, as the engine notes it when plan mode ends...
  on('prompt.attachment', { type: 'plan_mode_exit' }, async ($, e, next) => {
    const d = e.detail
    if (!d || d.hasPlan) {
      const exitPath = d ? d.planFilePath : null
      $.clock.after(0, () => void approved($, exitPath))
    }
    return next(e)
  })
  // ...and as the tool call that asked for it (a host whose note carries no path).
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.isError) $.clock.after(0, () => void approved($, null))
    return r
  }).catch(($, e, next) => next(e)) // never in the way of the tool call

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const cols = Math.max(20, e.props.bodyColumns)
    const doc = v.doc

    if (!doc) {
      const msg =
        v.status === 'loading' ? `Building the view of ${v.path}...`
        : v.status === 'error' ? `Couldn't show ${v.path}: ${v.error}`
        : `No plan open. ${USAGE}`
      return (
        <Box flexDirection="column">
          <Text color={v.status === 'error' ? 'red' : undefined} dimColor={v.status !== 'error'} wrap="wrap">{msg}</Text>
        </Box>
      )
    }

    const checkable = doc.tasks.filter(t => !t.browser_only)
    const done = checkable.filter(t => t.done).length
    const titles = new Map([...doc.sections, ...doc.stages].map(s => [s.id, s.title] as const))
    const rows: RenderElement[] = []
    let shown = 0

    const taskRow = (t: Task) => {
      const label = `${t.done ? '[x]' : '[ ]'} ${t.text}`
      if (t.browser_only) return <Text key={`t:${t.id}`} dimColor wrap="wrap">{`  ${t.text} (tracked in the site only)`}</Text>
      const isPending = v.pending === t.id
      return (
        <Button key={`t:${t.id}`} plain dimColor={!!v.pending} onPress={() => void toggle($, t, doc.revision)}>
          {isPending ? `... ${t.text}` : label}
        </Button>
      )
    }

    if (v.tab === 'roadmap') {
      if (!doc.stages.length) rows.push(<Text key="none" dimColor>No stages found. See Tasks.</Text>)
      for (const s of doc.stages) {
        rows.push(
          <Text key={`s:${s.id}`} wrap="truncate-end">
            {`${stageGlyph(s.done, s.total)} ${s.title}`} <Text dimColor>{`${s.done}/${s.total}`}</Text>
          </Text>,
        )
      }
      const current = doc.stages.find(s => s.done < s.total)
      if (current) {
        rows.push(<Text key="next" bold>{`Next up: ${current.title}`}</Text>)
        const open = doc.tasks.filter(t => !t.done && (t.section === current.id || t.at === current.id)).slice(0, 3)
        for (const t of open) rows.push(taskRow(t))
      }
    } else if (v.tab === 'tasks') {
      if (!doc.tasks.length) rows.push(<Text key="none" dimColor>No tasks in this plan.</Text>)
      const groups = new Map<string, Task[]>()
      for (const t of doc.tasks) groups.set(t.section, [...(groups.get(t.section) ?? []), t])
      for (const [section, list] of groups) {
        const visible = list.filter(t => v.showDone || !t.done)
        if (!visible.length) continue
        rows.push(<Text key={`g:${section}`} bold>{titles.get(section) ?? section}</Text>)
        for (const t of visible) {
          if (shown++ < MAX_ROWS) rows.push(taskRow(t))
        }
      }
      if (shown > MAX_ROWS) rows.push(<Text key="more" dimColor>{`${shown - MAX_ROWS} more: open the full site.`}</Text>)
      const doneCount = doc.tasks.filter(t => t.done).length
      if (doneCount) {
        rows.push(
          <Button key="show-done" plain dimColor onPress={() => void update($, view, x => ({ ...x, showDone: !x.showDone }))}>
            {v.showDone ? 'Hide done tasks' : `Show ${doneCount} done`}
          </Button>,
        )
      }
    } else if (v.tab === 'highlights') {
      if (!doc.highlights.length) rows.push(<Text key="none" dimColor>No decisions, risks or questions found.</Text>)
      for (const kind of ['decision', 'risk', 'question'] as const) {
        const list = doc.highlights.filter(h => h.kind === kind)
        if (!list.length) continue
        rows.push(<Text key={`k:${kind}`} bold>{{ decision: 'Decisions', risk: 'Risks', question: 'Open questions' }[kind]}</Text>)
        list.forEach((item, i) => { // not `h`: that is the JSX factory
          rows.push(<Text key={`h:${kind}:${i}`} wrap="wrap">{`• ${item.title}`}</Text>)
          if (item.mitigation) rows.push(<Text key={`m:${kind}:${i}`} dimColor wrap="wrap">{`  Mitigation: ${item.mitigation}`}</Text>)
        })
      }
    } else {
      if (!doc.files.length) rows.push(<Text key="none" dimColor>No files mentioned.</Text>)
      else rows.push(<Text key="legend" dimColor>● exists  ○ to create  ? ambiguous</Text>)
      for (const f of doc.files.slice(0, MAX_ROWS)) {
        rows.push(<Text key={`f:${f.path}`} wrap="truncate-start">{`${{ exists: '●', planned: '○', ambiguous: '?' }[f.status]} ${f.path}`}</Text>)
      }
    }

    return (
      <Box flexDirection="column">
        <Text bold wrap="wrap">{doc.title}</Text>
        <Text>
          {`${done}/${checkable.length} tasks `}
          <Text color="green">{bar(done, checkable.length, Math.min(20, cols - 18))}</Text>
          {` ${checkable.length ? Math.round((done / checkable.length) * 100) : 0}%`}
        </Text>
        {v.notice ? <Text key="notice" color="yellow" wrap="wrap">{v.notice}</Text> : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          {TABS.map(([id, label], i) => (
            <Button key={`tab:${id}`} hotkey={String(i + 1)} variant={v.tab === id ? 'primary' : undefined}
              onPress={() => void update($, view, x => ({ ...x, tab: id }))}>
              {label}
            </Button>
          ))}
        </Box>
        <Box flexDirection="column" marginTop={1}>{rows}</Box>
        <Box flexDirection="column" marginTop={1}>
          <Button key="open-site" onPress={() => void openSite($, doc.path)}>Open full site</Button>
          <Text dimColor wrap="truncate-start">{doc.path}</Text>
        </Box>
      </Box>
    )
  })
}
