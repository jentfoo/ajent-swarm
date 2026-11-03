import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { fleet as fleetAPI, models as modelsAPI } from '../api/endpoints'
import type { SavedSession } from '../api/types'
import { useAuth } from '../providers/auth'
import { useSwarm } from '../providers/swarm'
import { displayName, tildePath } from '../session/names'
import { SwitcherRows } from './SwitcherRows'
import type { SwitcherRow } from './switcher'
import { useSwitcherRows } from './useSwitcherRows'

// MobileHome is the launcher and switcher: live sessions first (the same rows
// the bottom sheet shows), then sections for new session, saved sessions,
// jobs and settings. Depth of controls trades for reachability here.
export default function MobileHome() {
  const navigate = useNavigate()
  const rows = useSwitcherRows()

  const open = useCallback(
    (row: SwitcherRow) => {
      if (row.status === 'ended') navigate(`/m/read/${encodeURIComponent(row.sessionId)}`)
      else navigate(`/s/${encodeURIComponent(row.sessionId)}`)
    },
    [navigate],
  )

  return (
    <div className="mobile-home">
      <section aria-label="Live sessions">
        <h2>Sessions</h2>
        <SwitcherRows rows={rows} onOpen={open} />
      </section>

      <NewSessionSection />

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
function NewSessionSection() {
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
// model choices from the models listing, and saved-session rows for resume
// showing title or path, recency and message count.
function LaunchForm({ onLaunched }: { onLaunched: (sessionId: string) => void | Promise<void> }) {
  const { home } = useAuth()
  const { sessions } = useSwarm()

  // One saved listing feeds the workspace suggestions and the resume rows.
  const [saved, setSaved] = useState<SavedSession[]>([])
  const [models, setModels] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    fleetAPI
      .saved()
      .then((rows) => alive && setSaved(rows))
      .catch(() => {})
    modelsAPI
      .list()
      .then((rows) => alive && setModels([...new Set(rows.map((r) => r.current.key))].sort()))
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
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
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

// SavedResume lists recorded sessions for resume. Rows show title or tilde
// path, recency and message count; newer-format recordings are marked blocked
// and refuse instead of launching into a guaranteed failure.
function SavedResume({
  home,
  saved,
  onResumed,
}: {
  home?: string
  saved: SavedSession[]
  onResumed: (sessionId: string) => void | Promise<void>
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const resume = async (row: SavedSession) => {
    if (busyId !== null) return
    if (!row.workspace) {
      setError('No recorded workspace for this session; launch manually.')
      return
    }
    setBusyId(row.id)
    setError('')
    try {
      const res = await fleetAPI.launch({
        workspace: row.workspace,
        mode: 'resume',
        target: row.target,
      })
      await onResumed(res.sessionId)
    } catch (err) {
      setBusyId(null)
      setError(err instanceof ApiError ? err.message : 'Resume failed.')
    }
  }

  return (
    <div className="saved-resume" aria-label="Saved sessions">
      <h3>Resume a saved session</h3>
      {error && <p className="error-text">{error}</p>}
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
              disabled={row.blocked || !row.workspace || busyId !== null}
              onClick={() => void resume(row)}
            >
              {busyId === row.id ? 'Resuming…' : 'Resume'}
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
