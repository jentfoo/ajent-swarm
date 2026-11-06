import { useCallback, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { fleet, sessions as sessionAPI } from '../api/endpoints'
import type { LaunchRequest, SessionStatus } from '../api/types'
import { ChildState, childEnded } from '../api/types'
import { useLaunchFacts } from '../hooks/useLaunchFacts'
import { useResume } from '../hooks/useResume'
import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { AgentSettingsMenu } from '../session/AgentSettingsMenu'
import { RenameControl } from '../session/RenameControl'
import { displayName, shortID, tildePath } from '../session/names'
import { describeStop } from '../workspace/attention'
import { ModelSelectOptions } from '../ui/ModelSelectOptions'

// SessionsHome is the live instance grid: state, workspace and seat badges
// beside quick actions per session, with a compact launch panel. Checkboxes
// multi-select sessions for tiling; an exited card stays listed with one-click
// resume and every live card keeps its explicit stop.
export default function SessionsHome() {
  const { sessions } = useSwarm()
  const auth = useAuth()
  const home = auth.home
  const [launching, setLaunching] = useState(false)
  // selection is by session id; Open workspace tiles them directly
  const [selected, setSelected] = useState<string[]>([])
  const navigate = useNavigate()

  const toggleSelected = useCallback((id: string) => {
    setSelected((sel) => (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]))
  }, [])

  // With a selection the workspace opens tile mode seeded with exactly those
  // sessions; without one it lands in the focused workspace as usual.
  const openWorkspace = () => {
    if (selected.length > 0) {
      navigate(`/tile?open=${selected.map(encodeURIComponent).join(',')}`)
      setSelected([])
      return
    }
    navigate('/focused')
  }

  return (
    <>
      <div className="session-header">
        <h1 style={{ margin: 0, fontSize: 'inherit' }}>Sessions</h1>
        <span className="spacer" style={{ flex: 1 }} />
        {selected.length > 0 && (
          <button type="button" className="accent" onClick={() => setSelected([])}>
            Clear selection
          </button>
        )}
        <button type="button" onClick={openWorkspace}>
          Open workspace
        </button>
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
            <SessionCard
              key={s.sessionId}
              status={s}
              home={home}
              selected={selected.includes(s.sessionId)}
              onSelect={() => toggleSelected(s.sessionId)}
            />
          ))}
        </div>
      )}
    </>
  )
}

// SessionCard is one grid tile: label with a rename control, badges and the
// quick actions. Renaming writes swarm's stored display title only.
function SessionCard({
  status: s,
  home,
  selected,
  onSelect,
}: {
  status: SessionStatus
  home?: string
  selected: boolean
  onSelect: () => void
}) {
  const stateClass = s.state === ChildState.Online ? 'ok' : childEnded(s.state) ? 'danger' : 'warn'
  const label = displayName(s, home)
  const ended = childEnded(s.state)
  const detail = cardDetail(s)
  // known facts only: no placeholder when the model or workspace is missing
  const tail = s.workspace?.split('/').filter(Boolean).pop()
  const facts = [s.model, tail].filter(Boolean).join(' · ')

  return (
    <div className={`card session-card ${ended ? 'ended' : ''}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4em' }}>
        <input
          type="checkbox"
          aria-label={`Select ${label} for tiling`}
          checked={selected}
          onChange={onSelect}
        />
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
        <RenameControl sessionId={s.sessionId} label={label} />
      </div>{' '}
      <div className="chips">
        <span className={`badge ${stateClass}`}>{s.state}</span>
        {s.spawnedBy === 'swarm' && <span className="badge accent">swarm</span>}
        {/* a held seat means a takeover is needed; the free default stays quiet */}
        {s.seatHeld && (
          <span className={s.seatOurs ? 'badge accent' : 'badge warn'}>
            seat: {s.seatHolder || 'held'}
          </span>
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
      {facts && (
        <p className="muted" style={{ margin: '0.2em 0' }}>
          {facts}
        </p>
      )}
      {/* exits are never mysterious: the detail line and last-stop reason sit here */}
      {detail && (
        <p className="muted card-detail" style={{ margin: '0.2em 0' }}>
          {detail}
        </p>
      )}
      <ActionsBar status={s} />
    </div>
  )
}

// cardDetail picks the card's story line: the exit note once ended, else the
// last turn's end in the shared rail vocabulary.
function cardDetail(s: SessionStatus): string {
  if (childEnded(s.state)) return s.detail ?? ''
  if (s.lastStopErr) return `last turn failed: ${s.lastStopErr}`
  return s.lastStop ? describeStop(s.lastStop, undefined) : ''
}

// ActionsBar holds the quick actions: open, agent settings and stop for live
// cards, resume for ended ones. The settings ☰ edits this card's session, so
// no separate picker is needed anywhere. The stop endpoint escalates on its
// own: /exit first, then SIGTERM and SIGKILL for swarm children; external
// sessions end through /exit alone.
function ActionsBar({ status: s }: { status: SessionStatus }) {
  const ended = childEnded(s.state)
  return (
    <div style={{ display: 'flex', gap: '0.5em', marginTop: '0.4em', flexWrap: 'wrap' }}>
      <Link to={`/focused?session=${encodeURIComponent(s.sessionId)}`}>
        <button type="button">Open</button>
      </Link>
      {ended ? (
        <ResumeButton status={s} />
      ) : (
        <>
          <StopButton sessionId={s.sessionId} />
          <AgentSettingsMenu sessionId={s.sessionId} />
        </>
      )}
    </div>
  )
}

// StopButton is the explicit exit control on every live card.
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

// ResumeButton relaunches an exited swarm child by its session id through the
// shared resume path, the same headless `--resume id` launch uses.
function ResumeButton({ status: s }: { status: SessionStatus }) {
  const { resume, resumingId, error } = useResume()

  if (!s.workspace) return null // resume needs the working directory back

  return (
    <>
      <button
        type="button"
        className="primary"
        disabled={resumingId !== null}
        onClick={() => void resume(s.workspace!, s.sessionId)}
      >
        Resume
      </button>
      {error && <span className="error-text">{error}</span>}
    </>
  )
}

function LaunchPanel({ home }: { home?: string }) {
  const navigate = useNavigate()
  // One launch-facts source: workspaces from live and saved sessions, the
  // deduped model listing and the saved rows the resume target matches against.
  const { saved, models, workspaceOptions } = useLaunchFacts()

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
            <ModelSelectOptions models={models} />
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
