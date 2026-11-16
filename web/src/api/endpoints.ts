import { del, get, post, postForm, put } from './client'
import type {
  AgentsListResult,
  AgentsStopResult,
  AttachmentReply,
  AttentionAck,
  AttentionRow,
  CtlState,
  EntriesPage,
  FilesReply,
  GlobalSettings,
  Job,
  LaunchRequest,
  LaunchResult,
  MeReply,
  ModelListing,
  ModeReply,
  ModelState,
  QueueRequest,
  QueueRecallRow,
  RecallLinesReply,
  RecallRow,
  ResolveAnswer,
  ResolveReply,
  RewindCandidates,
  RewindReply,
  Run,
  SavedEntriesPage,
  SavedSession,
  SchedulePreview,
  SessionStatus,
  SettingSetReply,
  SettingsRowsReply,
  SubmitReply,
  ToolSetReply,
  ToolState,
} from './types'

// Auth endpoints. Bootstrap answers 409 once a password already exists.
export const auth = {
  me: () => get<MeReply>('/api/me'),
  login: (username: string, password: string) =>
    post<void>('/api/auth/login', { username, password }),
  logout: () => post<void>('/api/auth/logout'),
  bootstrap: (password: string) => post<void>('/api/auth/bootstrap', { password }),
}

// Session listing and lifecycle.
export const fleet = {
  sessions: () => get<SessionStatus[]>('/api/sessions'),
  attention: () => get<AttentionRow[]>('/api/attention'),
  // Server-side attention acknowledgments: one check-off settles every device.
  ackAttention: (req: AttentionAck) => post<void>('/api/attention/ack', req),
  launch: (req: LaunchRequest) => post<LaunchResult>('/api/sessions', req),
  saved: () => get<SavedSession[]>('/api/saved-sessions'),
  // Offline transcript read for a recorded session, before continues the walk
  // back in time from a previous page's cursor.
  savedEntries: (id: string, before = '', limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (before !== '') params.set('before', before)
    return get<SavedEntriesPage>(`/api/saved-sessions/${encodeURIComponent(id)}/entries?${params}`)
  },
}

// Model options for swarm-level pickers: every live session's registry
// unioned into one sorted list.
export const models = {
  options: (signal?: AbortSignal) => get<ModelState[]>('/api/models/options', { signal }),
}

// Tool options for swarm-level pickers: every live session's /tools rows
// unioned by name, best-effort since availability differs per workspace.
export const tools = {
  options: (signal?: AbortSignal) => get<ToolState[]>('/api/tools/options', { signal }),
}

// Swarm-level settings, persisted in swarm's database across restarts.
export const settings = {
  get: (signal?: AbortSignal) => get<GlobalSettings>('/api/settings', { signal }),
  set: (next: GlobalSettings) => put<GlobalSettings>('/api/settings', next),
}

// Session reads and commands against one live instance.
const withID = (id: string, suffix: string) => `/api/sessions/${encodeURIComponent(id)}${suffix}`

export const sessions = {
  snapshot: (id: string, signal?: AbortSignal) =>
    get<CtlState>(withID(id, '/snapshot'), { signal }),
  entries: (id: string, before: string, limit: number, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (before !== '') params.set('before', before)
    params.set('limit', String(limit))
    return get<EntriesPage>(`${withID(id, '/entries')}?${params}`, { signal })
  },
  stop: (id: string) => post<void>(withID(id, '/stop')),
  takeControl: (id: string) => post<void>(withID(id, '/take-control')),
  submit: (id: string, line: string, pendingId?: string) =>
    post<SubmitReply>(withID(id, '/submit'), { line, pendingId }),
  // queue parks the line until the session has been idle for the park window
  queue: (id: string, line: string, pendingId?: string) =>
    post<SubmitReply>(withID(id, '/queue'), { line, pendingId }),
  queueRecall: (id: string) => post<QueueRecallRow>(withID(id, '/queue/recall')),
  interrupt: (id: string) => post<{ stopped?: string }>(withID(id, '/interrupt')),
  // mode jumps straight to a named level, upstream's cycle stays server-side
  setMode: (id: string, mode: string) => post<ModeReply>(withID(id, '/mode'), { mode }),
  rewind: (id: string, head: string) => post<RewindReply>(withID(id, '/rewind'), { head }),
  resolve: (id: string, answer: ResolveAnswer) =>
    post<ResolveReply>(withID(id, '/resolve'), answer),
  recall: (id: string) => post<RecallRow>(withID(id, '/recall')),
  // agents.list is the structured sub-agent read, stop takes one job id or
  // {all:true}, with exactly-one validated upstream.
  agents: (id: string, signal?: AbortSignal) =>
    get<AgentsListResult>(withID(id, '/agents'), { signal }),
  stopAgents: (id: string, target: { id?: string; all?: boolean }) =>
    post<AgentsStopResult>(withID(id, '/agents/stop'), target),
  // The workspace recall listing behind Ctrl+R: what ajent recalls for this
  // session's workspace merged with swarm's typed submits, ?query narrows
  // server-side.
  recallLines: (id: string, query = '', limit = 500, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (query !== '') params.set('query', query)
    return get<RecallLinesReply>(`${withID(id, '/recall-lines')}?${params}`, { signal })
  },
  candidates: (id: string, signal?: AbortSignal) =>
    get<RewindCandidates>(withID(id, '/candidates'), { signal }),
  files: (id: string, query: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ query })
    return get<FilesReply>(`${withID(id, '/files')}?${params}`, { signal })
  },
  attach: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return postForm<AttachmentReply>(withID(id, '/attachments'), form)
  },

  // models.get and model.set without riding a picker dialog.
  models: (id: string, signal?: AbortSignal) =>
    get<ModelListing>(withID(id, '/models'), { signal }),
  setModel: (id: string, model: string) => post<{ model: string }>(withID(id, '/model'), { model }),

  // tools.set reshapes the enabled set, settings.get/set read and write rows.
  setTools: (id: string, names: string[]) => post<ToolSetReply>(withID(id, '/tools'), { names }),
  settings: (id: string, signal?: AbortSignal) =>
    get<SettingsRowsReply>(withID(id, '/settings'), { signal }),
  setSetting: (id: string, key: string, value: unknown, persist?: 'user' | 'project') =>
    post<SettingSetReply>(withID(id, '/setting'), { key, value, persist }),

  // swarm-side display titles, empty clears, ajent's own names stay untouched.
  setTitle: (id: string, title: string) => post<void>(withID(id, '/title'), { title }),
}

// Scheduled jobs and their run history. preview evaluates one draft schedule
// server-side through the trigger loop's own arithmetic, queue parks one
// prompt on a one-shot row that waits for an idle fleet.
export const jobsApi = {
  list: (signal?: AbortSignal) => get<Job[]>('/api/jobs', { signal }),
  create: (job: Partial<Job>) => post<Job>('/api/jobs', job),
  queue: (req: QueueRequest) => post<Job>('/api/jobs/queue', req),
  update: (id: number, job: Partial<Job>) => put<Job>(`/api/jobs/${id}`, job),
  remove: (id: number) => del<void>(`/api/jobs/${id}`),
  fire: (id: number) => post<Run>(`/api/jobs/${id}/run`),
  preview: (job: Partial<Job>, count = 3, signal?: AbortSignal) =>
    post<SchedulePreview>('/api/jobs/preview', { ...job, count }, { signal }),
}

// Run history across every job, ?job= narrows to one.
export const runsApi = {
  list: (jobId?: number, limit = 200, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (jobId !== undefined) params.set('job', String(jobId))
    return get<Run[]>(`/api/runs?${params}`, { signal })
  },
}
