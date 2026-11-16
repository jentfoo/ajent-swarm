// Human display names for sessions: the stored swarm title when one exists,
// else the agent's own name, else its workspace directory with $HOME folded to
// ~, else a short id. Every surface that lists sessions renders through here
// so mobile switcher rows and desktop rail rows agree on one label.
interface NamedSession {
  sessionId: string
  title?: string
  name?: string
  workspace?: string
}

// displayName picks the most readable label available for a session row.
export function displayName(
  s: Pick<NamedSession, 'sessionId' | 'title' | 'name' | 'workspace'>,
  home: string | undefined,
): string {
  if (s.title) return s.title
  if (s.name) return s.name
  if (s.workspace) return tildePath(s.workspace, home)
  return shortID(s.sessionId)
}

// tildePath renders an absolute path relative to the service's home directory
// paths outside it stay absolute.
export function tildePath(p: string, home: string | undefined): string {
  if (!home || !p.startsWith(home + '/')) return p
  if (p === home) return '~'
  return '~' + p.slice(home.length)
}

// shortID trims a session id for display beside its title.
export function shortID(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8) + '…'
}
