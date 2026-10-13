// What the too-long side pane keeps in the session's state. The summary fields mirror what
// scripts/pane.py prints for `model`.

export type Tab = 'roadmap' | 'tasks' | 'highlights' | 'files'

export type Stage = { id: string; title: string; done: number; total: number }

export type Task = {
  id: string
  text: string
  done: boolean
  section: string
  at: string
  line: number
  browser_only: boolean
}

export type Highlight = { kind: 'decision' | 'risk' | 'question'; title: string; line: number; mitigation?: string }

export type PlanFile = { path: string; status: 'exists' | 'planned' | 'ambiguous' }

export type PaneDoc = {
  revision: string
  title: string
  file: string
  path: string
  index: string
  sections: { id: string; title: string }[]
  stages: Stage[]
  tasks: Task[]
  highlights: Highlight[]
  files: PlanFile[]
}

export type PaneView = {
  /** idle: no plan yet; loading: first build; ready: doc shown; error: first build failed. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The plan shown, as a real path. */
  path: string
  /** The last summary that loaded. Kept when a later refresh fails. */
  doc: PaneDoc | null
  /** Why the first build failed (status error). */
  error: string
  /** A lasting problem shown above the last good state (refresh failed, file missing). */
  notice: string
  /** The task being written, while a write runs. */
  pending: string
  tab: Tab
  showDone: boolean
}

export type PlanMode = {
  /** The plan file of the current or latest planning, as the engine named it. */
  path: string
  /** The band above the prompt offers to open this plan in the pane: set when plan mode names a new
   * file, cleared once the pane shows it or the person dismisses the offer. */
  isOffered?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'too-long-live': { view: PaneView; plan: PlanMode }
  }
}
