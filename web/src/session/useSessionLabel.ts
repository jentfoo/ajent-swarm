import { useAuth } from '../providers/auth'
import { useSwarm } from '../providers/swarm'
import { displayName, shortID } from './names'

// useSessionLabel resolves one session's label through displayName over the
// live swarm listing, keeping every chrome that names a session on the rail's
// chain. A session the listing does not carry yet shows its short id.
export function useSessionLabel(sessionId: string): string {
  const { sessions } = useSwarm()
  const { home } = useAuth()
  const row = sessions.find((s) => s.sessionId === sessionId)
  return row ? displayName(row, home) : shortID(sessionId)
}
