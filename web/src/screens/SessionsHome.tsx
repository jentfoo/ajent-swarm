import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { fleet, models as modelsAPI, sessions as sessionAPI } from '../api/endpoints'
import type { LaunchRequest, SavedSession, SessionStatus } from '../api/types'
import { ChildState } from '../api/types'
import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { displayName, tildePath } from '../session/names'

// SessionsHome is the live instance grid: model, workspace and seat badges
// beside quick actions per session, with a compact launch panel. Open walks
// into the inbox workspace with the session selected; /s/:id stays the
// standalone deep link.
export default function SessionsHome() {
  const { sessions } = useSwarm()
  const auth = useAuth()
  const home = auth.home
  const [launching, setLaunching] = useState(false)

  return (
    <>
      <div className="session-header">
        <h1 style={{ margin: 0, fontSize: 'inherit' }}>Sessions</h1>
        <span className="spacer" style={{ flex: 1 }} />
        <Link to="/inbox">
          <button type="button">Open workspace</button>
        </Link>
        <button type="button" onClick={() => setLaunching((v) => !v)}>
          {launching ? 'Close' : 'Launch session'}
        </button>
      </div>

      {launching && <LaunchPanel home={home} />}

      {sessions.length === 0 ? (
        <p className="muted">No live sessions. Launch one or start `ajent --serve` yourself.</p>
      ) : (
        <div className="grid">
          {sessions.map((s) => (
            <SessionCard key={s.sessionId} status={s} home={home} />
          ))}
        </div>
      )}
    </>
  )
}

function SessionCard({ status: s, home }: { status: SessionStatus; home?: string }) {
  const stateClass =
    s.state === ChildState.Online
      ? 'ok'
      : s.state === ChildState.Exited || s.state === ChildState.Gone
        ? 'danger'
        : 'warn'
  const label = displayName(s, home)

  return (
    <div className="card">
      <div>
        {s.name ? (
          <>
            <Link to={`/s/${encodeURIComponent(s.sessionId)}`}>{label}</Link>{' '}
            <span className="muted mono">{shortID(s.sessionId)}</span>
          </>
        ) : (
          <Link to={`/s/${encodeURIComponent(s.sessionId)}`} title={s.workspace ?? s.sessionId}>
            {label}
          </Link>
        )}
      </div>
      <div className="chips">
        <span className={`badge ${stateClass}`}>{s.state}</span>
        {s.spawnedBy === 'swarm' && <span className="badge accent">swarm</span>}
        {s.seatHeld ? (
          <span className={s.seatOurs ? 'badge accent' : 'badge warn'}>
            seat: {s.seatHolder || 'held'}
          </span>
        ) : (
          <span className="badge">seat free</span>
        )}
        {s.openInteractions > 0 && (
          <span className="badge danger">{s.openInteractions} need input</span>
        )}
        {s.running ? (
          <span className="badge accent">running</span>
        ) : s.idle && s.state === ChildState.Online ? (
          <span className="badge">idle</span>
        ) : null}
      </div>
      <p className="muted" style={{ margin: '0.2em 0' }}>
        {s.model || 'model unknown'}
        {s.workspace ? ` · ${shortPath(s.workspace)}` : ''}
      </p>
      <ActionsBar sessionId={s.sessionId} spawnedBy={s.spawnedBy} state={s.state} />
    </div>
  )
}

function ActionsBar({
  sessionId,
  spawnedBy,
  state,
}: {
  sessionId: string
  spawnedBy: 'swarm' | 'external'
  state: string
}) {
  return (
    <div style={{ display: 'flex', gap: '0.5em', marginTop: '0.4em' }}>
      <Link to={`/inbox?session=${encodeURIComponent(sessionId)}`}>
        <button type="button">Open</button>
      </Link>
      {spawnedBy === 'swarm' && state !== ChildState.Exited && <StopButton sessionId={sessionId} />}
    </div>
  )
}

function StopButton({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const stop = async () => {
    setBusy(true)
    setError('')
    try {
      await sessionAPI.stop(sessionId)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Stop failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" onClick={() => void stop()} disabled={busy}>
        Stop
      </button>
      {error && <span className="error-text">{error}</span>}
    </>
  )
}

function LaunchPanel({ home }: { home?: string }) {
  const navigate = useNavigate()
  const { sessions } = useSwarm()

  // Workspaces come from every session we have seen, live or saved, most
  // recently used first; the custom entry reveals a free-text input.
  const [saved, setSaved] = useState<SavedSession[]>([])
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    fleet
      .saved()
      .then((rows) => alive && setSaved(rows))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    let alive = true
    modelsAPI
      .list()
      .then((rows) => {
        if (!alive) return
        setModels([...new Set(rows.map((r) => r.current.key))].sort())
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const workspaceOptions = useMemo(() => {
    const seen: string[] = []
    for (const s of [...sessions, ...saved]) {
      if (s.workspace && !seen.includes(s.workspace)) seen.push(s.workspace)
    }
    return seen
  }, [sessions, saved])

  const [workspaceChoice, setWorkspaceChoice] = useState('') // '' = custom
  const [customWorkspace, setCustomWorkspace] = useState('')
  const workspace = workspaceChoice === '' ? customWorkspace : workspaceChoice

  // No mode picker: empty target launches new; a saved-session id resumes it;
  // anything else is a create-or-resume session name.
  const [target, setTarget] = useState('')
  const launchRequest = useCallback((): LaunchRequest | string => {
    if (workspace.trim() === '') return 'Pick the working directory to start under.'
    const t = target.trim()
    if (t === '') return { workspace: workspace.trim(), mode: 'new' }
    const savedHit = saved.find((row) => row.id === t)
    if (savedHit !== undefined) {
      return { workspace: workspace.trim(), mode: 'resume', target: savedHit.target }
    }
    return { workspace: workspace.trim(), mode: 'session', target: t }
  }, [workspace, target, saved])

  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (busy) return
    const req = launchRequest()
    if (typeof req === 'string') {
      setError(req)
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await fleet.launch({ ...req, model: model.trim() === '' ? undefined : model })
      navigate(`/s/${encodeURIComponent(res.sessionId)}`)
    } catch (err) {
      setBusy(false)
      setError(err instanceof ApiError ? err.message : 'Launch failed.')
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: '1em' }}>
      <label>
        Working directory
        <select value={workspaceChoice} onChange={(ev) => setWorkspaceChoice(ev.target.value)}>
          <option value="">Custom path…</option>
          {workspaceOptions.map((w) => (
            <option key={w} value={w}>
              {tildePath(w, home)}
            </option>
          ))}
        </select>
      </label>
      {workspaceChoice === '' && (
        <label>
          Directory path
          <input
            placeholder="/home/you/project"
            value={customWorkspace}
            onChange={(ev) => setCustomWorkspace(ev.target.value)}
          />
        </label>
      )}
      <div style={{ display: 'flex', gap: '0.5em', flexWrap: 'wrap' }}>
        <label>
          Session id or name (optional)
          <input
            placeholder="empty starts a new session"
            value={target}
            onChange={(ev) => setTarget(ev.target.value)}
          />
        </label>
        <label>
          Model
          <select value={model} onChange={(ev) => setModel(ev.target.value)}>
            <option value="">ajent default</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="error-text">{error}</p>}
      <button className="primary" type="submit" disabled={busy}>
        Launch
      </button>
    </form>
  )
}

function shortID(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8) + '…'
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length === 0 ? p : parts[parts.length - 1]
}
