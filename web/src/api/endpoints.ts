import { get, post, postForm, request } from './client'
import type {
  AttachmentReply,
  AttentionRow,
  CtlState,
  EntriesPage,
  LaunchRequest,
  LaunchResult,
  MeReply,
  ModelRow,
  ModeReply,
  RecallRow,
  ResolveAnswer,
  ResolveReply,
  RewindCandidates,
  RewindReply,
  SessionStatus,
  SubmitReply,
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
}

// Models listing; with ?session= it opens ajent's own picker for that
// session, answered later through resolve.
export const models = {
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
  attach: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return postForm<AttachmentReply>(withID(id, '/attachments'), form)
  },
}
