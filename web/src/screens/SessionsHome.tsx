import { useCallback, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import { ChildState, childEnded } from '../api/types'
import type { SessionStatus } from '../api/types'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { useLaunchFacts } from '../hooks/useLaunchFacts'
import { useLaunchForm, type LaunchTarget } from '../hooks/useLaunchForm'
import { useResume } from '../hooks/useResume'
import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { AgentSettingsMenu } from '../session/AgentSettingsMenu'
import { RenameControl } from '../session/RenameControl'
import { displayName, shortID } from '../session/names'
import { describeStop, instanceKey } from '../workspace/attention'
import { ModelSelect, WorkspaceSelect } from '../ui/LaunchFormFields'

// SessionsHome is the live instance grid: state, workspace and seat badges
// beside quick actions per session, with a compact launch panel. Checkboxes
// multi-select sessions for tiling; an exited card stays listed with one-click
// resume and every live card keeps its explicit stop.
export default function SessionsHome() {
  const { sessions } = useSwarm()
  const auth = useAuth()
  const home = auth.home
  const [launching, setLaunching] = useState(false)
  // selection is by row key; Open workspace tiles them directly
  const [selected, setSelected] = useState<string[]>([])
  const navigate = useNavigate()

  // sessions listed twice carry a pid badge so the cards stay tellable apart
  const twinIds = useMemo(() => {
    const seen = new Set<string>()
    const twins = new Set<string>()
    for (const s of sessions) {
      if (seen.has(s.sessionId)) twins.add(s.sessionId)
      seen.add(s.sessionId)
    }
    return twins
  }, [sessions])

  const toggleSelected = useCallback((key: string) => {
    setSelected((sel) => (sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key]))
  }, [])

  // With a selection the workspace opens tile mode seeded with exactly those
  // sessions; without one it lands in the focused workspace as usual. Twin
  // rows repeat their session id so both tile.
  const openWorkspace = () => {
    if (selected.length > 0) {
      const idsOf = new Map(sessions.map((s) => [instanceKey(s.sessionId, s.pid), s.sessionId]))
      const ids = selected
        .map((k) => idsOf.get(k))
        .filter((id): id is string => id !== undefined)
        .map(encodeURIComponent)
      navigate(`/tile?open=${ids.join(',')}`)
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
              key={instanceKey(s.sessionId, s.pid)}
              status={s}
              home={home}
              twin={twinIds.has(s.sessionId)}
              selected={selected.includes(instanceKey(s.sessionId, s.pid))}
              onSelect={() => toggleSelected(instanceKey(s.sessionId, s.pid))}
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
  twin,
  selected,
  onSelect,
}: {
  status: SessionStatus
  home?: string
  twin: boolean // another live row serves the same session id
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
          aria-label={`Select ${label}${twin ? ` (pid ${s.pid ?? 0})` : ''} for tiling`}
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
        {twin && <span className="badge">pid {s.pid ?? 0}</span>}
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
// no separate picker is needed anywhere.
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

// StopButton is the explicit exit control on every live card, armed before
// it fires: the first click asks "Stop?", a second within the window stops.
// The stop endpoint escalates on its own: /exit first, then SIGTERM and
// SIGKILL for swarm children; external sessions end through /exit alone.
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

  const confirm = useArmedConfirm(() => void stop(), { disabled: busy })

  return (
    <>
      <button
        type="button"
        className={`danger${confirm.armed ? ' armed' : ''}`}
        onClick={confirm.onClick}
        onBlur={confirm.onBlur}
        disabled={busy}
      >
        {confirm.armed ? 'Stop?' : 'Stop'}
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
  const form = useLaunchForm()

  // No mode picker: empty target launches new; a saved-session id resumes it;
  // anything else is a create-or-resume session name.
  const [target, setTarget] = useState('')
  const launchTarget = useCallback((): LaunchTarget => {
    const t = target.trim()
    if (t === '') return { mode: 'new' }
    const savedHit = saved.find((row) => row.id === t)
    if (savedHit !== undefined) return { mode: 'resume', target: savedHit.target }
    return { mode: 'session', target: t }
  }, [target, saved])

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    const id = await form.launch(launchTarget())
    if (id !== null) navigate(`/s/${encodeURIComponent(id)}`)
  }

  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: '1em' }}>
      <WorkspaceSelect form={form} workspaceOptions={workspaceOptions} home={home} />
      <div style={{ display: 'flex', gap: '0.5em', flexWrap: 'wrap' }}>
        <label>
          Session id or name (optional)
          <input
            placeholder="empty starts a new session"
            value={target}
            onChange={(ev) => setTarget(ev.target.value)}
          />
        </label>
        <ModelSelect form={form} models={models} />
      </div>
      {form.error && <p className="error-text">{form.error}</p>}
      <button className="primary" type="submit" disabled={form.busy}>
        Launch
      </button>
    </form>
  )
}
