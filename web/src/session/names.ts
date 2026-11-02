// Human display names for sessions: the agent's own name when it has one,
// else its workspace directory with $HOME folded to ~, else a short id.
// Every surface that lists sessions renders through here so rail rows, tile
// tabs and cards agree on one label per session.
import type { SessionStatus } from '../api/types'

export interface NamedSession {
  sessionId: string
  name?: string
  workspace?: string
}

// displayName picks the most readable label available for a session row.
export function displayName(
  s: Pick<SessionStatus, 'sessionId' | 'name' | 'workspace'>,
  home: string | undefined,
): string {
  if (s.name) return s.name
  if (s.workspace) return tildePath(s.workspace, home)
  return shortID(s.sessionId)
}

// tildePath renders an absolute path relative to the service's home directory;
// paths outside it stay absolute.
export function tildePath(p: string, home: string | undefined): string {
  if (!home || !p.startsWith(home + '/')) return p
  if (p === home) return '~'
  return '~' + p.slice(home.length)
}

function shortID(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8) + '…'
}
