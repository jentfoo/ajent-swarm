import { useCallback, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import type { SavedSession } from '../api/types'
import { useLaunchFacts, type LaunchFacts } from '../hooks/useLaunchFacts'
import { useLaunchForm } from '../hooks/useLaunchForm'
import { useResume } from '../hooks/useResume'
import { useAuth } from '../providers/auth'
import { useSwarm } from '../providers/swarm'
import { displayName, tildePath } from '../session/names'
import { relativeTime } from '../session/rewind'
import { ModelSelect, WorkspaceSelect } from '../ui/LaunchFormFields'
import { SwitcherRows } from './SwitcherRows'
import { switcherRoute, type SwitcherRow } from './switcher'
import { usePullToRefresh } from './usePullToRefresh'
import { useSwitcherRows } from './useSwitcherRows'

// MobileHome is the launcher and switcher: the new-session launcher on top,
// then the grouped live session rows (section headings included), then links
// for jobs and settings. Depth of controls trades for reachability here.
export default function MobileHome() {
  const navigate = useNavigate()
  const rows = useSwitcherRows()
  const { refreshSessions } = useSwarm()
  const facts = useLaunchFacts()

  // pull-to-refresh re-reads both listings in parallel, each keeps its own
  // error story, so a refusal only means stale rows until the next poll. The
  // status rides .pull-refresh out of flow: inserting it mid-gesture must
  // never displace the content beneath.
  const { refreshSaved } = facts
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshSessions(), refreshSaved()])
  }, [refreshSessions, refreshSaved])
  const surfaceRef = useRef<HTMLDivElement>(null)
  const refreshing = usePullToRefresh(surfaceRef, refreshAll)

  const open = useCallback((row: SwitcherRow) => navigate(switcherRoute(row)), [navigate])

  return (
    <div className="mobile-home" ref={surfaceRef}>
      <NewSessionSection facts={facts} />

      <section aria-label="Live sessions">
        <SwitcherRows rows={rows} onOpen={open} />
      </section>

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

      {refreshing && (
        <p className="pull-refresh muted" role="status">
          <span className="pull-refresh-spin" aria-hidden />
          Refreshing…
        </p>
      )}
    </div>
  )
}

// NewSessionSection keeps the launcher collapsed until asked, so the launch
// button stays one tap without its form pushing the session list down.
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

// LaunchForm shares the desktop launch panel's form body through
// useLaunchForm: workspace suggestions drawn from every seen session
// most-recent-first with a custom free-text reveal, model choices grouped per
// provider through the shared options body, and saved-session rows for resume
// showing title or path, recency and message count.
function LaunchForm({
  facts,
  onLaunched,
}: {
  facts: LaunchFacts
  onLaunched: (sessionId: string) => void | Promise<void>
}) {
  const { home } = useAuth()
  const { saved, models, workspaceOptions } = facts
  const form = useLaunchForm()

  const launchNew = async () => {
    const id = await form.launch({ mode: 'new' })
    if (id !== null) await onLaunched(id)
  }

  return (
    <div className="card launch-form">
      <WorkspaceSelect
        form={form}
        workspaceOptions={workspaceOptions}
        home={home}
        customPathTestId="custom-workspace"
      />
      <ModelSelect form={form} models={models} />
      {form.error && <p className="error-text">{form.error}</p>}
      <button
        className="primary"
        type="button"
        disabled={form.busy || form.workspace.trim() === ''}
        onClick={() => void launchNew()}
        data-testid="launch-new"
      >
        {form.busy ? 'Launching…' : 'Launch'}
      </button>

      <SavedResume home={home} saved={saved} onResumed={onLaunched} />
    </div>
  )
}

// SavedResume lists recorded sessions for resume, riding the shared resume
// path. Rows show title or tilde path, recency and message count, newer-format
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
          { sessionId: row.id, name: row.name, workspace: row.workspace },
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
              {tildePath(row.workspace ?? '', home) || row.target} · {relativeTime(row.updatedMs)} ·{' '}
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
