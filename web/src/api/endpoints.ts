import { del, get, post, postForm, put, request } from './client'
import type {
  AttachmentReply,
  AttentionRow,
  CtlState,
  EntriesPage,
  FilesReply,
  Job,
  LaunchRequest,
  LaunchResult,
  MeReply,
  ModelListing,
  ModelRow,
  ModeReply,
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
  launch: (req: LaunchRequest) =>
    request<LaunchResult>('/api/sessions', { method: 'POST', body: req }),
  saved: () => get<SavedSession[]>('/api/saved-sessions'),
  // Offline transcript read for a recorded session; before continues the walk
  // back in time from a previous page's cursor.
  savedEntries: (id: string, before = '', limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (before !== '') params.set('before', before)
    return get<SavedEntriesPage>(`/api/saved-sessions/${encodeURIComponent(id)}/entries?${params}`)
  },
}

// Model listing; ?session= opens ajent's own picker for that session,
// answered later through resolve. Bare returns one row per live session.
export const models = {
  list: () => get<ModelRow[]>('/api/models'),
  discover: (sessionId: string) =>
    get<ModelRow[]>(`/api/models?session=${encodeURIComponent(sessionId)}`),
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
  interrupt: (id: string) => post<{ stopped?: string }>(withID(id, '/interrupt')),
  modeCycle: (id: string, back = false) => post<ModeReply>(withID(id, '/mode'), { back }),
  rewind: (id: string, head: string) => post<RewindReply>(withID(id, '/rewind'), { head }),
  resolve: (id: string, answer: ResolveAnswer) =>
    post<ResolveReply>(withID(id, '/resolve'), answer),
  recall: (id: string) => post<RecallRow>(withID(id, '/recall')),
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

  // tools.set reshapes the enabled set; settings.get/set read and write rows.
  setTools: (id: string, names: string[]) => post<ToolSetReply>(withID(id, '/tools'), { names }),
  settings: (id: string, signal?: AbortSignal) =>
    get<SettingsRowsReply>(withID(id, '/settings'), { signal }),
  setSetting: (id: string, key: string, value: unknown, persist?: 'user' | 'project') =>
    post<SettingSetReply>(withID(id, '/setting'), { key, value, persist }),

  // swarm-side display titles; empty clears, ajent's own names stay untouched.
  setTitle: (id: string, title: string) => post<void>(withID(id, '/title'), { title }),
}

// Scheduled jobs and their run history. preview evaluates one draft schedule
// server-side through the trigger loop's own arithmetic.
export const jobsApi = {
  list: () => get<Job[]>('/api/jobs'),
  create: (job: Partial<Job>) => post<Job>('/api/jobs', job),
  update: (id: number, job: Partial<Job>) => put<Job>(`/api/jobs/${id}`, job),
  remove: (id: number) => del<void>(`/api/jobs/${id}`),
  fire: (id: number) => post<Run>(`/api/jobs/${id}/run`),
  preview: (job: Partial<Job>, count = 3, signal?: AbortSignal) =>
    post<SchedulePreview>('/api/jobs/preview', { ...job, count }, { signal }),
}

// Run history across every job; ?job= narrows to one.
export const runsApi = {
  list: (jobId?: number, limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (jobId !== undefined) params.set('job', String(jobId))
    return get<Run[]>(`/api/runs?${params}`)
  },
}
