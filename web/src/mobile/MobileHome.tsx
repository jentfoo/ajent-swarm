import { useCallback, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { fleet as fleetAPI } from '../api/endpoints'
import type { SavedSession } from '../api/types'
import { ApiError } from '../api/client'
import { useLaunchFacts, type LaunchFacts } from '../hooks/useLaunchFacts'
import { useResume } from '../hooks/useResume'
import { useAuth } from '../providers/auth'
import { useSwarm } from '../providers/swarm'
import { displayName, tildePath } from '../session/names'
import { ModelSelectOptions } from '../ui/ModelSelectOptions'
import { SwitcherRows } from './SwitcherRows'
import type { SwitcherRow } from './switcher'
import { usePullToRefresh } from './usePullToRefresh'
import { useSwitcherRows } from './useSwitcherRows'

// MobileHome is the launcher and switcher: the grouped live sessions the
// bottom sheet shows (section headings included), then sections for new
// session, saved sessions, jobs and settings. Depth of controls trades for
// reachability here.
export default function MobileHome() {
  const navigate = useNavigate()
  const rows = useSwitcherRows()
  const { refreshSessions } = useSwarm()
  const facts = useLaunchFacts()

  // pull-to-refresh re-reads both listings in parallel; each keeps its own
  // error story, so a refusal only means stale rows until the next poll.
  const { refreshSaved } = facts
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshSessions(), refreshSaved()])
  }, [refreshSessions, refreshSaved])
  const surfaceRef = useRef<HTMLDivElement>(null)
  const refreshing = usePullToRefresh(surfaceRef, refreshAll)

  const open = useCallback(
    (row: SwitcherRow) => {
      if (row.status === 'ended') navigate(`/m/read/${encodeURIComponent(row.sessionId)}`)
      else navigate(`/s/${encodeURIComponent(row.sessionId)}`)
    },
    [navigate],
  )

  return (
    <div className="mobile-home" ref={surfaceRef}>
      {refreshing && (
        <p className="muted" role="status">
          Refreshing…
        </p>
      )}

      <section aria-label="Live sessions">
        <SwitcherRows rows={rows} onOpen={open} />
      </section>

      <NewSessionSection facts={facts} />

      <nav className="mobile-links" aria-label="More">
        <Link to="/jobs" data-testid="link-jobs">
          Jobs
          <span className="muted">scheduled runs and history</span>
        </Link>
        <Link to="/m/settings" data-testid="link-settings">
          Settings
          <span className="muted">theme and global settings</span>
        </Link>
      </nav>
    </div>
  )
}

// NewSessionSection keeps the launcher collapsed until asked, so the switcher
// stays the screen's first thing on a phone.
function NewSessionSection({ facts }: { facts: LaunchFacts }) {
  const navigate = useNavigate()
  const { refreshSessions } = useSwarm()

  const [open, setOpen] = useState(false)
  return (
    <section aria-label="New session">
      <h2>
        New session{' '}
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Launch…'}
        </button>
      </h2>
      {open && (
        <LaunchForm
          facts={facts}
          onLaunched={async (id) => {
            await refreshSessions()
            navigate(`/s/${encodeURIComponent(id)}`)
          }}
        />
      )}
    </section>
  )
}

// LaunchForm mirrors the desktop launch panel: workspace suggestions drawn
// from every seen session most-recent-first with a custom free-text reveal,
// model choices grouped per provider through the shared options body, and
// saved-session rows for resume showing title or path, recency and message
// count.
function LaunchForm({
  facts,
  onLaunched,
}: {
  facts: LaunchFacts
  onLaunched: (sessionId: string) => void | Promise<void>
}) {
  const { home } = useAuth()
  const { saved, models, workspaceOptions } = facts

  const [workspaceChoice, setWorkspaceChoice] = useState('') // '' = custom reveal
  const [customWorkspace, setCustomWorkspace] = useState('')
  const workspace = workspaceChoice === '' ? customWorkspace : workspaceChoice

  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const launchNew = async () => {
    if (busy || workspace.trim() === '') return
    setBusy(true)
    setError('')
    try {
      const res = await fleetAPI.launch({
        workspace: workspace.trim(),
        mode: 'new',
        model: model.trim() === '' ? undefined : model,
      })
      await onLaunched(res.sessionId)
    } catch (err) {
      setBusy(false)
      setError(err instanceof ApiError ? err.message : 'Launch failed.')
    }
  }

  return (
    <div className="card launch-form">
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
            data-testid="custom-workspace"
          />
        </label>
      )}
      <label>
        Model
        <select value={model} onChange={(ev) => setModel(ev.target.value)}>
          <option value="">ajent default</option>
          <ModelSelectOptions models={models} />
        </select>
      </label>
      {error && <p className="error-text">{error}</p>}
      <button
        className="primary"
        type="button"
        disabled={busy || workspace.trim() === ''}
        onClick={() => void launchNew()}
        data-testid="launch-new"
      >
        {busy ? 'Launching…' : 'Launch'}
      </button>

      <SavedResume home={home} saved={saved} onResumed={onLaunched} />
    </div>
  )
}

// SavedResume lists recorded sessions for resume, riding the shared resume
// path. Rows show title or tilde path, recency and message count; newer-format
// recordings are marked blocked and refuse instead of launching into a
// guaranteed failure.
function SavedResume({
  home,
  saved,
  onResumed,
}: {
  home?: string
  saved: SavedSession[]
  onResumed: (sessionId: string) => void | Promise<void>
}) {
  const [missing, setMissing] = useState('')
  const { resume, resumingId, error } = useResume(onResumed)

  const start = (row: SavedSession) => {
    if (!row.workspace) {
      setMissing('No recorded workspace for this session; launch manually.')
      return
    }
    void resume(row.workspace, row.target)
  }

  return (
    <div className="saved-resume" aria-label="Saved sessions">
      <h3>Resume a saved session</h3>
      {(missing || error) && <p className="error-text">{missing || error}</p>}
      {saved.length === 0 && <p className="muted">Nothing recorded yet.</p>}
      {saved.map((row) => {
        const label = displayName(
          { sessionId: row.id, title: row.name, name: row.name, workspace: row.workspace },
          home,
        )
        return (
          <div key={row.id} className="saved-row card" data-testid={`saved-${row.id}`}>
            <span className="switch-top">
              <span className="switch-name">{label}</span>
              {row.blocked && <span className="badge danger">newer format</span>}
              {row.live && <span className="badge accent">live</span>}
            </span>
            <span className="muted saved-meta">
              {tildePath(row.workspace ?? '', home) || row.target} · {relTime(row.updatedMs)} ·{' '}
              {row.messages} message{row.messages === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              disabled={row.blocked || !row.workspace || resumingId !== null}
              onClick={() => start(row)}
            >
              {resumingId === row.target ? 'Resuming…' : 'Resume'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

// relTime renders a short recency label for saved rows.
function relTime(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
