import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { fleet, sessions as sessionAPI } from '../api/endpoints'
import type { LaunchMode, SessionStatus } from '../api/types'
import { ChildState } from '../api/types'
import { useSwarm } from '../providers/swarm'

// SessionsHome is the live instance grid: model, workspace and seat badges
// beside quick actions per session, with a compact launch panel. Open walks
// into the inbox workspace with the session selected; /s/:id stays the
// standalone deep link.
export default function SessionsHome() {
  const { sessions } = useSwarm()
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

      {launching && <LaunchPanel />}

      {sessions.length === 0 ? (
        <p className="muted">No live sessions. Launch one or start `ajent --serve` yourself.</p>
      ) : (
        <div className="grid">
          {sessions.map((s) => (
            <SessionCard key={s.sessionId} status={s} />
          ))}
        </div>
      )}
    </>
  )
}

function SessionCard({ status: s }: { status: SessionStatus }) {
  const stateClass =
    s.state === ChildState.Online
      ? 'ok'
      : s.state === ChildState.Exited || s.state === ChildState.Gone
        ? 'danger'
        : 'warn'

  return (
    <div className="card">
      <div>
        {s.name ? (
          <>
            <Link to={`/s/${encodeURIComponent(s.sessionId)}`}>{s.name}</Link>{' '}
            <span className="muted mono">{shortID(s.sessionId)}</span>
          </>
        ) : (
          <Link to={`/s/${encodeURIComponent(s.sessionId)}`} className="mono">
            {shortID(s.sessionId)}
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

function LaunchPanel() {
  const navigate = useNavigate()
  const [workspace, setWorkspace] = useState('')
  const [mode, setMode] = useState<LaunchMode>('new')
  const [target, setTarget] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (busy || workspace.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const res = await fleet.launch({
        workspace: workspace.trim(),
        mode,
        target: mode === 'resume' || mode === 'session' ? target.trim() : undefined,
        model: model.trim() === '' ? undefined : model.trim(),
      })
      navigate(`/s/${encodeURIComponent(res.sessionId)}`)
    } catch (err) {
      setBusy(false)
      setError(err instanceof ApiError ? err.message : 'Launch failed.')
    }
  }

  const needsTarget = mode === 'resume' || mode === 'session'

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: '1em' }}>
      <label>
        Workspace directory
        <input
          placeholder="/home/you/project"
          required
          value={workspace}
          onChange={(ev) => setWorkspace(ev.target.value)}
        />
      </label>
      <div style={{ display: 'flex', gap: '0.5em', flexWrap: 'wrap' }}>
        <label>
          Mode
          <select value={mode} onChange={(ev) => setMode(ev.target.value as LaunchMode)}>
            <option value="new">new</option>
            <option value="resume">resume</option>
            <option value="continue">continue</option>
            <option value="session">session name</option>
          </select>
        </label>
        {needsTarget && (
          <label>
            Target
            <input value={target} onChange={(ev) => setTarget(ev.target.value)} />
          </label>
        )}
        <label>
          Model (optional)
          <input value={model} onChange={(ev) => setModel(ev.target.value)} />
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
