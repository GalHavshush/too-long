// The side pane against the engine's own test kit:  claude plugin test .
// Python is stood in for by a process.run hook that answers as scripts/pane.py does, the file
// system by an fs.stat hook over a table of fake files, and time by the mock clock.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'too-long-pane'
const PANE_PROPS = { title: 'too-long', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

type Fake = {
  files: Map<string, { mtimeMs: number; size: number }>
  calls: string[][]
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
    files: [{ path: 'src/a.ts', status: 'exists' }],
    warnings: [],
  }
}

function fake(on: On): Fake {
  const f: Fake = {
    files: new Map(), calls: [], toasts: [], opened: [], task: { status: 'applied' }, revision: 1, done: new Set(),
    isPlaced: true, isModelBroken: false, isDesignDoc: false, holdModel: null, clock: mock.clock(on, { now: 1000 }),
  }
  mock.store(on)
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    if (argv[1] === '-c') return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const args = argv.slice(2)
    f.calls.push(args)
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
    } else out = { status: 'ok' }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', ($, e) => {
    const s = f.files.get(e.path)
    if (!s) return { deny: `ENOENT: ${e.path}` }
    return { value: { kind: 'file' as const, size: s.size, mtimeMs: s.mtimeMs, isLink: false, realPath: e.path } }
  })
  on('session.root', () => ({ value: '/proj' }))
  on('env.get', () => ({ value: '/home/me' }))
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
  return $.command.run({ command: 'too-long-pane', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
}

// Stops the plan's watcher, as the session ending does (the kit cannot close a pane).
function end($: Engine) {
  return $.session.end({ reason: 'other', sessionId: 'test', resume: { id: 'test' } } as never)
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
    expect((await ui.find({ text: 'Next up: Phase 1' }))).toBeDefined()
    await ui.press({ key: 'tab:highlights' })
    expect((await ui.find({ text: /↳ Wrap labels\./ }))).toBeDefined()
    await ui.press({ key: 'tab:files' })
    expect((await ui.find({ text: /src\/a\.ts/ }))).toBeDefined()
    expect((await ui.find({ text: /1 exist · 0 to create/ }))).toBeDefined()
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
  expect(await ui.find({ text: 'Next up: Remaining work' })).toBeDefined()
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
  expect(f.calls.find(c => c[0] === 'task')).toEqual(['task', '/plans/c.md', 'a', '--done', '--revision', 'rev1'])
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

function note($: Engine, type: 'plan_mode' | 'plan_mode_exit', path: string) {
  const detail = type === 'plan_mode' ? { planFilePath: path, hasPlan: true, reminder: 'full' as const } : { planFilePath: path, hasPlan: true }
  return $.prompt.attachment({ type, text: type, origin: { kind: 'engine' }, detail } as never)
}

function exitPlanMode($: Engine) {
  return $.tool.call({ tool: 'ExitPlanMode', input: {} } as never)
}

test('only the approval opens the plan; replayed notes never do', async ($, on) => {
  const f = fake(on)
  let isRejected = false
  on('tool.call', () => (isRejected ? { deny: 'The user rejected the plan' } : { result: {}, text: 'approved' }) as never)
  f.files.set('/home/me/.claude/plans/old.md', { mtimeMs: 1, size: 10 })
  f.files.set('/home/me/.claude/plans/p.md', { mtimeMs: 1, size: 10 })
  // The engine renders old rows again when a mod loads: an earlier planning and its exit.
  await note($, 'plan_mode', '/home/me/.claude/plans/old.md')
  await note($, 'plan_mode_exit', '/home/me/.claude/plans/old.md')
  await note($, 'plan_mode', '/home/me/.claude/plans/p.md')
  await f.clock.settle()
  expect(f.opened).toEqual([])
  isRejected = true
  await exitPlanMode($)
  await f.clock.settle()
  expect(f.opened).toEqual([])
  isRejected = false
  await exitPlanMode($)
  await f.clock.settle()
  expect(f.opened).toEqual(['too-long'])
  expect(f.calls[0]?.[1]).toBe('/home/me/.claude/plans/p.md') // the latest planning's file
  await end($)
})

test('an approval with no known plan file says how to open one', async ($, on) => {
  const f = fake(on)
  on('tool.call', () => ({ result: {}, text: 'approved' }) as never)
  await exitPlanMode($)
  await f.clock.settle()
  expect(f.opened).toEqual([])
  expect(f.toasts.at(-1)).toContain('/too-long-pane <path-to-plan.md>')
})

test('an approval on a narrow terminal leaves a toast instead', async ($, on) => {
  const f = fake(on)
  on('tool.call', () => ({ result: {}, text: 'approved' }) as never)
  f.isPlaced = false
  f.files.set('/plans/r.md', { mtimeMs: 1, size: 10 })
  await note($, 'plan_mode', '/plans/r.md')
  await exitPlanMode($)
  await f.clock.settle()
  expect(f.toasts.at(-1)).toContain('Run /too-long-pane to open it')
  await end($)
})
