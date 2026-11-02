import { get, post, request } from './client'
import type {
  AttentionRow,
  CtlState,
  EntriesPage,
  LaunchRequest,
  LaunchResult,
  MeReply,
  SessionStatus,
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

// Session reads and commands against one live instance.
export const sessions = {
  snapshot: (id: string, signal?: AbortSignal) =>
    get<CtlState>(`/api/sessions/${encodeURIComponent(id)}/snapshot`, { signal }),
  entries: (id: string, before: string, limit: number, signal?: AbortSignal) => {
    const params = new URLSearchParams()
    if (before !== '') params.set('before', before)
    params.set('limit', String(limit))
    return get<EntriesPage>(`/api/sessions/${encodeURIComponent(id)}/entries?${params}`, { signal })
  },
  stop: (id: string) => post<void>(`/api/sessions/${encodeURIComponent(id)}/stop`),
  takeControl: (id: string) => post<void>(`/api/sessions/${encodeURIComponent(id)}/take-control`),
}
