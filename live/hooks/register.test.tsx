// The side pane against the engine's own test kit:  claude plugin test .
// Python is stood in for by a process.run hook that answers as scripts/pane.py does, the file
// system by an fs.stat hook over a table of fake files, and time by the mock clock.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'too-long-live'
const PANE_PROPS = { title: 'too-long', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

type Fake = {
  files: Map<string, { mtimeMs: number; size: number }>
  calls: string[][]
  scripts: string[]
  toasts: string[]
  opened: string[]
  task: { status: string; revision?: string }
  revision: number
  done: Set<string>
  isPlaced: boolean
  isModelBroken: boolean
  isDesignDoc: boolean
  holdModel: Promise<void> | null
  clock: ReturnType<typeof mock.clock>
}

function doc(f: Fake, path: string) {
  const tasks = ['a', 'b', 'c'].map((id, i) => ({
    id, text: `Task ${id}`, done: f.done.has(id), section: i < 2 ? 'phase-1' : 'phase-2', at: i < 2 ? 'phase-1' : 'phase-2', line: 5 + i, browser_only: false,
  }))
  return {
    status: 'ok', revision: `rev${f.revision}`, title: 'Ship it', file: 'plan.md', path, out: '/out', index: '/out/index.html',
    sections: [{ id: 'phase-1', title: 'Phase 1' }, { id: 'phase-2', title: 'Phase 2' }],
    stages: [
      { id: 'phase-1', title: 'Phase 1', done: tasks.filter(t => t.section === 'phase-1' && t.done).length, total: 2 },
      { id: 'phase-2', title: 'Phase 2', done: tasks.filter(t => t.section === 'phase-2' && t.done).length, total: 1 },
    ],
    tasks,
    highlights: [{ kind: 'risk', title: 'The pane is narrow.', mitigation: 'Wrap labels.', line: 9 }],
    files: [
      { path: 'src/a.ts', status: 'exists' }, { path: 'src/lib/b.ts', status: 'planned' }, { path: 'README.md', status: 'exists' },
      { path: '~/.claude/plans/', status: 'exists' }, { path: 'index.html', status: 'ambiguous' },
    ],
    warnings: [],
  }
}

function fake(on: On): Fake {
  const f: Fake = {
    files: new Map(), calls: [], scripts: [], toasts: [], opened: [], task: { status: 'applied' }, revision: 1, done: new Set(),
    isPlaced: true, isModelBroken: false, isDesignDoc: false, holdModel: null, clock: mock.clock(on, { now: 1000 }),
  }
  f.files.set('/home/me/.claude/skills/too-long/scripts/pane.py', { mtimeMs: 1, size: 1 }) // the installed skill
  mock.store(on)
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    if (argv[1] === '-c') return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const args = argv.slice(2)
    f.calls.push(args)
    f.scripts.push(argv[1] ?? '')
    let out: unknown
    if (args[0] === 'model') {
      if (f.holdModel) await f.holdModel
      out = f.isModelBroken ? { status: 'error', error: 'config.json: bad view' } : doc(f, args[1] ?? '')
      if (f.isDesignDoc) { // numbered sections without tasks; the tasks sit in a later section
        const d = out as ReturnType<typeof doc>
        d.stages = [{ id: 'goals', title: '1. Goals', done: 0, total: 0 }, { id: 'design', title: '2. Design', done: 0, total: 0 }]
        d.sections = [...d.sections, { id: 'todo', title: 'Remaining work' }]
        d.tasks = d.tasks.map(t => ({ ...t, section: 'todo', at: 'todo' }))
      }
    } else if (args[0] === 'task') {
      out = f.task
      if (f.task.status === 'applied') {
        args[3] === '--done' ? f.done.add(args[2] ?? '') : f.done.delete(args[2] ?? '')
        f.revision++
      }
    } else if (args[0] === 'config') {
      const config = JSON.parse(args[2] ?? '{}')
      out = config.notes?.nope ? { status: 'error', error: "config notes has unknown section id 'nope'", sections: ['phase-1', 'phase-2'] } : { status: 'ok' }
    } else out = { status: 'ok' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', ($, e) => {
    const s = f.files.get(e.path)
    if (!s) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file' as const, size: s.size, mtimeMs: s.mtimeMs, isLink: false, realPath: e.path } }
  })
  on('session.root', () => ({ value: '/proj' }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    f.opened.push(e.id)
    return { value: f.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'terminal is 80 columns' } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', ($, e) => {
    f.toasts.push(e.text)
    return { value: undefined }
  })
  return f
}

function touch(f: Fake, path: string, size = 100) {
  const s = f.files.get(path)
  f.files.set(path, { mtimeMs: (s?.mtimeMs ?? 0) + 1, size })
}

function run($: Engine, args: string) {
  return $.command.run({ command: 'too-long-live', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
}

// Stops the plan's watcher, as the session ending does (the kit cannot close a pane).
function end($: Engine) {
  return $.session.end({ reason: 'other', sessionId: 'test', resume: { id: 'test' } } as never)
}

async function pressSettled(f: Fake, ui: Awaited<ReturnType<typeof mountPane>>, key: string) {
  const pressed = ui.press({ key })
  await f.clock.settle()
  await pressed
}

const models = (f: Fake) => f.calls.filter(c => c[0] === 'model').length

async function mountPane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'too-long', props: PANE_PROPS })
}

test('the command shows a plan, and says how to use it without one', async ($, on) => {
  const f = fake(on)
  expect((await run($, '')).text).toContain('Usage')
  f.files.set('/plans/a.md', { mtimeMs: 1, size: 10 })
  const r = await run($, '"/plans/a.md"')
  expect(r.text).toContain('/plans/a.md')
  await f.clock.settle()
  expect(f.opened).toEqual(['too-long'])
  expect(f.calls[0]).toEqual(['model', '/plans/a.md', '--root', '/proj'])
  // A new session: no planning yet, the store remembers the last plan of this project.
  await end($)
  f.opened.length = 0
  expect((await run($, '')).text).toContain('/plans/a.md')
  await end($)
})

test('a missing plan is reported, not opened', async ($, on) => {
  const f = fake(on)
  expect((await run($, '~/nope.md')).text).toBe('Plan not found: /home/me/nope.md')
  expect(f.opened).toEqual([])
})

test('the pane draws the plan on every surface', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/b.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/b.md')
  await f.clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: 'Ship it' }))).toBeDefined()
    expect((await ui.find({ text: /0\/3 tasks/ }))).toBeDefined()
    expect((await ui.find({ text: 'NEXT UP' }))).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^Phase 1$/ })).length).toBe(2) // the card, and "now" in the header
    await ui.press({ key: 'tab:highlights' })
    expect((await ui.find({ text: /↳ Wrap labels\./ }))).toBeDefined()
    await ui.press({ key: 'tab:files' })
    expect((await ui.find({ text: /3 exist · 1 to create · 1 unclear/ }))).toBeDefined()
    // A folder tree: folders first, nested by depth, paths outside the project last; "~/.claude/"
    // holds only plans/, so they share one row.
    const rows = (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('f:'))
    expect(rows.map(r => [r.key, r.props.paddingLeft])).toEqual([
      ['f:src/', 0], ['f:src/lib/', 2], ['f:src/lib/b.ts', 4], ['f:src/a.ts', 2],
      ['f:index.html', 0], ['f:README.md', 0], ['f:~/.claude/plans/', 0],
    ])
    await ui.press({ key: 'tab:roadmap' })
    await ui.unmount()
  }
  await end($)
})

test('a roadmap of task-less sections points at the open tasks instead', async ($, on) => {
  const f = fake(on)
  f.isDesignDoc = true
  f.files.set('/plans/s.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/s.md')
  await f.clock.settle()
  const ui = await mountPane($)
  expect(await ui.find({ text: /1\. Goals/ })).toBeUndefined()
  expect(await ui.find({ text: 'Stages' })).toBeUndefined()
  expect(await ui.find({ text: 'NEXT UP' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^Remaining work$/ })).length).toBe(2)
  expect(await ui.find({ key: 't:a' })).toBeDefined()
  await ui.unmount()
  await end($)
})

test('ticking a task writes it with the revision shown, then refreshes', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/c.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/c.md')
  await f.clock.settle()
  const ui = await mountPane($)
  await ui.press({ key: 'tab:tasks' })
  await ui.press({ key: 't:a' })
  expect(f.calls.find(c => c[0] === 'task')).toEqual(['task', '/plans/c.md', 'a', '--done', '--revision', 'rev1', '--root', '/proj'])
  expect(f.calls.at(-1)?.[0]).toBe('model')
  expect(await ui.find({ text: /1\/3 tasks/ })).toBeDefined()
  expect(await ui.find({ key: 't:a' })).toBeUndefined() // done tasks fold away
  await ui.press({ key: 'show-done' })
  expect(await ui.find({ key: 't:a' })).toBeDefined()
  await ui.unmount()
  await end($)
})

test('a conflict refreshes and asks again, never retries', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/d.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/d.md')
  await f.clock.settle()
  const ui = await mountPane($)
  await ui.press({ key: 'tab:tasks' })
  f.task = { status: 'conflict', revision: 'rev9' }
  await ui.press({ key: 't:b' })
  expect(f.calls.filter(c => c[0] === 'task').length).toBe(1)
  expect(f.calls.at(-1)?.[0]).toBe('model')
  expect(f.toasts.at(-1)).toContain('Plan changed outside the pane')
  f.task = { status: 'busy' }
  await ui.press({ key: 't:b' })
  expect(f.toasts.at(-1)).toContain('another process')
  await ui.unmount()
  await end($)
})

test('a second press while a write runs is not written', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/e.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/e.md')
  await f.clock.settle()
  const ui = await mountPane($)
  await ui.press({ key: 'tab:tasks' })
  let release = () => {}
  f.holdModel = new Promise(r => (release = r)) // the refresh after the first write hangs
  const first = ui.press({ key: 't:a' })
  await f.clock.settle()
  await ui.press({ key: 't:b' })
  expect(f.toasts.at(-1)).toContain('saving the previous change')
  release()
  f.holdModel = null
  await first
  expect(f.calls.filter(c => c[0] === 'task').map(c => c[2])).toEqual(['a'])
  await ui.unmount()
  await end($)
})

test('edits are debounced, rebuilt once, and identical builds do not redraw', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/g.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/g.md')
  await f.clock.settle()
  expect(models(f)).toBe(1)
  await f.clock.advance(1000)
  expect(models(f)).toBe(1) // nothing changed
  // Three saves in a row, a tick apart: no build until the file holds still for a tick.
  touch(f, '/plans/g.md')
  await f.clock.advance(1000)
  touch(f, '/plans/g.md')
  await f.clock.advance(1000)
  touch(f, '/plans/g.md')
  await f.clock.advance(1000)
  expect(models(f)).toBe(1)
  await f.clock.advance(1000)
  expect(models(f)).toBe(2)
  await f.clock.advance(3000)
  expect(models(f)).toBe(2)
  await end($)
  touch(f, '/plans/g.md')
  await f.clock.advance(3000)
  expect(models(f)).toBe(2) // ended: no more polling
})

test('a change during a build builds again', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/h.md', { mtimeMs: 1, size: 10 })
  let release = () => {}
  f.holdModel = new Promise(r => (release = r))
  await run($, '/plans/h.md')
  await f.clock.settle()
  touch(f, '/plans/h.md') // saved while the first build runs
  f.holdModel = null
  release()
  await f.clock.settle()
  expect(models(f)).toBe(2)
  await end($)
})

test('a failed refresh keeps the last good state; a deleted plan says so', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/i.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/i.md')
  await f.clock.settle()
  const ui = await mountPane($)
  f.isModelBroken = true
  touch(f, '/plans/i.md')
  await f.clock.advance(2000)
  expect(await ui.find({ text: 'Ship it' })).toBeDefined()
  expect(await ui.find({ text: /Unable to refresh plan, showing last known state\. \(config\.json: bad view\)/ })).toBeDefined()
  f.isModelBroken = false
  touch(f, '/plans/i.md')
  await f.clock.advance(2000)
  expect(await ui.find({ text: /Unable to refresh/ })).toBeUndefined()
  f.files.delete('/plans/i.md')
  await f.clock.advance(1000)
  expect(await ui.find({ text: /Plan file not found: \/plans\/i\.md/ })).toBeDefined()
  expect(await ui.find({ text: 'Ship it' })).toBeDefined()
  await ui.unmount()
  await end($)
})

test('a first build that fails shows why', async ($, on) => {
  const f = fake(on)
  f.isModelBroken = true
  f.files.set('/plans/j.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/j.md')
  await f.clock.settle()
  const ui = await mountPane($)
  expect(await ui.find({ text: /Couldn't show \/plans\/j\.md: config\.json: bad view/ })).toBeDefined()
  await ui.unmount()
  await end($)
})

test('switching plans moves the one watcher; reopening keeps it', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/k.md', { mtimeMs: 1, size: 10 })
  f.files.set('/plans/l.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/k.md')
  await f.clock.settle()
  await run($, '/plans/k.md')
  await f.clock.settle()
  expect(models(f)).toBe(1) // same plan: no second watcher, no rebuild
  await run($, '/plans/l.md')
  await f.clock.settle()
  expect(f.calls.at(-1)?.[1]).toBe('/plans/l.md')
  const before = models(f)
  touch(f, '/plans/k.md') // the old plan is no longer watched
  await f.clock.advance(3000)
  expect(models(f)).toBe(before)
  await end($)
})

function note($: Engine, type: 'plan_mode' | 'plan_mode_exit', path: string, reminder: 'full' | 'sparse' = 'full') {
  const detail = type === 'plan_mode' ? { planFilePath: path, hasPlan: true, reminder } : { planFilePath: path, hasPlan: true }
  return $.prompt.attachment({ type, text: type, origin: { kind: 'engine' }, detail } as never)
}

function exitPlanMode($: Engine) {
  return $.tool.call({ tool: 'ExitPlanMode', input: {} } as never)
}

const BAND_PROPS = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} } as const

function mountBand($: Engine, on: On) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { // the engine's own band
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  return $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', requestId: 'band', props: BAND_PROPS })
}

test('a new plan is offered by a button; nothing opens until it is pressed', async ($, on) => {
  const f = fake(on)
  on('tool.call', () => ({ result: {}, text: 'approved' }) as never)
  const band = await mountBand($, on)
  expect(await band.find({ key: 'open-plan' })).toBeUndefined() // no plan yet
  f.files.set('/home/me/.claude/plans/p.md', { mtimeMs: 1, size: 10 })
  await note($, 'plan_mode', '/home/me/.claude/plans/p.md')
  await exitPlanMode($) // approval opens nothing; the offer stays after it
  await f.clock.settle()
  expect(f.opened).toEqual([])
  expect(await band.find({ key: 'open-plan' })).toBeDefined()
  await band.press({ key: 'open-plan' })
  await f.clock.settle()
  expect(f.opened).toEqual(['too-long'])
  expect(f.calls[0]?.[1]).toBe('/home/me/.claude/plans/p.md')
  expect(await band.find({ key: 'open-plan' })).toBeUndefined() // shown: offered no more
  await note($, 'plan_mode', '/home/me/.claude/plans/p.md') // the same file again: no new offer
  expect(await band.find({ key: 'open-plan' })).toBeUndefined()
  await band.unmount()
  await end($)
})

test('a dismissed offer stays dismissed until plan mode names another file', async ($, on) => {
  const f = fake(on)
  const band = await mountBand($, on)
  await note($, 'plan_mode', '/plans/a.md')
  await band.press({ key: 'dismiss-plan' })
  expect(await band.find({ key: 'open-plan' })).toBeUndefined()
  await note($, 'plan_mode', '/plans/a.md')
  expect(await band.find({ key: 'open-plan' })).toBeUndefined()
  await note($, 'plan_mode', '/plans/b.md')
  expect(await band.find({ key: 'open-plan' })).toBeDefined()
  expect(f.opened).toEqual([])
  await band.unmount()
})

test('the command takes the offer too', async ($, on) => {
  const f = fake(on)
  const band = await mountBand($, on)
  f.files.set('/plans/c.md', { mtimeMs: 1, size: 10 })
  await note($, 'plan_mode', '/plans/c.md')
  await run($, '')
  await f.clock.settle()
  expect(f.opened).toEqual(['too-long'])
  expect(await band.find({ key: 'open-plan' })).toBeUndefined()
  await band.unmount()
  await end($)
})

test("the plan's row in the transcript carries the button", async ($, on) => {
  const f = fake(on)
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine-row">{String(e.props.tool)}</Text>
  })
  f.files.set('/plans/r.md', { mtimeMs: 1, size: 10 })
  await note($, 'plan_mode', '/plans/r.md')
  const props = (tool: string, id: string) => ({ tool_use_id: id, tool, input: {}, isRunning: true, isErrored: false, isInterrupted: false })
  const other = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'ToolUse', requestId: 'r1', props: props('Bash', 'r1') } as never)
  expect(await other.find({ key: 'open-plan:r1' })).toBeUndefined()
  await other.unmount()
  const row = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'ToolUse', requestId: 'r2', props: props('ExitPlanMode', 'r2') } as never)
  expect(await row.find({ text: 'ExitPlanMode' })).toBeDefined() // the engine's row is kept
  await row.press({ key: 'open-plan:r2' })
  await f.clock.settle()
  expect(f.opened).toEqual(['too-long'])
  expect(f.calls[0]?.[1]).toBe('/plans/r.md')
  await row.unmount()
  await end($)
})

test('planning is told to write trackable plans and offer a review; approval, to tick tasks', async ($, on) => {
  fake(on)
  const full = await note($, 'plan_mode', '/plans/p.md')
  expect(full.text).toContain('plan_mode') // the engine's own words stay first
  expect(full.text).toContain('`- [ ] ...`')
  expect(full.text).toContain('before ExitPlanMode ask the user with AskUserQuestion')
  const sparse = await note($, 'plan_mode', '/plans/p.md', 'sparse')
  expect(sparse.text).toBe('plan_mode') // said once, not every turn
  const exit = await note($, 'plan_mode_exit', '/plans/p.md')
  expect(exit.text).toContain('The approved plan is /plans/p.md')
  expect(exit.text).toContain('change that box to `- [x]`')
})

test('show_plan saves the config Claude chose, or says how to fix it', async ($, on) => {
  const f = fake(on)
  f.files.set('/plans/v.md', { mtimeMs: 1, size: 10 })
  const call = (config: object) => $.tool.call({ tool: 'mcp__too-long-live__show_plan', path: '/plans/v.md', config } as never)
  const bad = await call({ notes: { nope: 'x' } }) as { result?: unknown }
  expect(bad.result).toContain("unknown section id 'nope'") // a string: what the model reads
  expect(bad.result).toContain('Section ids: phase-1, phase-2')
  expect(f.opened).toEqual([]) // nothing shown with a refused config
  await call({ views: ['roadmap'], tldr: ['Short.'] })
  await f.clock.settle()
  expect(f.calls[1]).toEqual(['config', '/plans/v.md', '{"views":["roadmap"],"tldr":["Short."]}', '--root', '/proj'])
  expect(f.opened).toEqual(['too-long'])
  await end($)
})

test('without the skill installed the pane says how to install it', async ($, on) => {
  const f = fake(on)
  f.files.delete('/home/me/.claude/skills/too-long/scripts/pane.py')
  f.files.set('/plans/n.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/n.md')
  await f.clock.settle()
  const ui = await mountPane($)
  expect(await ui.find({ text: /not installed in \/home\/me\/\.claude\/skills\/too-long/ })).toBeDefined()
  expect(f.calls).toEqual([])
  await ui.unmount()
  await end($)
})

test("a project's own install of the skill comes first", async ($, on) => {
  const f = fake(on)
  f.files.set('/proj/.claude/skills/too-long/scripts/pane.py', { mtimeMs: 1, size: 1 })
  f.files.set('/plans/s.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/s.md')
  await f.clock.settle()
  expect(f.scripts[0]).toBe('/proj/.claude/skills/too-long/scripts/pane.py')
  await end($)
})

test('Open full site starts the live site once and opens its address', async ($, on) => {
  const f = fake(on)
  const spawns: string[][] = []
  let stop = () => {}
  const stopped = new Promise<void>(resolve => (stop = resolve))
  on('process.spawn', async function* ($, e) {
    spawns.push([...e.argv].slice(2))
    yield { stream: 'stdout' as const, text: '{"status": "serving", "url": "http://127.0.0.1:4321/"}\n' }
    await stopped // serves until stopped
    return { value: { code: 0, signal: null } }
  })
  f.files.set('/plans/t.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/t.md')
  await f.clock.settle()
  const ui = await mountPane($)
  await pressSettled(f, ui, 'open-site') // the server starts on a timer
  await pressSettled(f, ui, 'open-site')
  expect(spawns).toEqual([['serve', '/plans/t.md', '--root', '/proj']])
  expect(f.calls.filter(c => c[0] === 'open')).toEqual([
    ['open', '/plans/t.md', '--url', 'http://127.0.0.1:4321/', '--root', '/proj'],
    ['open', '/plans/t.md', '--url', 'http://127.0.0.1:4321/', '--root', '/proj'],
  ])
  stop()
  await ui.unmount()
  await end($)
})

test('a live site that does not start falls back to the static copy', async ($, on) => {
  const f = fake(on)
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"status": "error", "error": "port in use"}\n' }
    return { value: { code: 1, signal: null } }
  })
  f.files.set('/plans/u.md', { mtimeMs: 1, size: 10 })
  await run($, '/plans/u.md')
  await f.clock.settle()
  const ui = await mountPane($)
  await pressSettled(f, ui, 'open-site')
  expect(f.calls.filter(c => c[0] === 'open')).toEqual([['open', '/plans/u.md', '--root', '/proj']])
  expect(f.toasts.at(-1)).toContain('opened the static copy')
  await ui.unmount()
  await end($)
})

test('the skill shows the plan it built through the show_plan tool', async ($, on) => {
  const f = fake(on)
  f.files.set('/home/me/proj/plan.md', { mtimeMs: 1, size: 10 })
  const r = await $.tool.call({ tool: 'mcp__too-long-live__show_plan', path: '~/proj/plan.md' } as never)
  await f.clock.settle()
  expect((r as { result?: unknown }).result).toContain('/home/me/proj/plan.md')
  expect(f.opened).toEqual(['too-long'])
  expect(f.calls[0]).toEqual(['model', '/home/me/proj/plan.md', '--root', '/proj'])
  await end($)
})
