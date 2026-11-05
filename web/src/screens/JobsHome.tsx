import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { ApiError } from '../api/client'
import { jobsApi, runsApi, tools as toolsApi } from '../api/endpoints'
import type { Job, Run, ToolState } from '../api/types'
import { useLaunchFacts } from '../hooks/useLaunchFacts'
import { usePoll } from '../hooks/usePoll'
import { useAuth } from '../providers/auth'
import { tildePath } from '../session/names'
import { JobEditor } from '../jobs/JobEditor'
import { duplicateDraft } from '../jobs/jobDraft'
import type { JobDraft } from '../jobs/jobDraft'
import { JobTabs } from '../jobs/JobTabs'
import { formatSlot, runStatusClass, scheduleSummary, sortJobsForDisplay } from '../jobs/schedule'

const pollJobsMs = 10_000
// A page deep enough that every job's latest run is on it for most installs.
const lastRunPage = 200

// JobsHome lists scheduled jobs over /api/jobs: plain-language schedules,
// next fire times, an optimistic enabled toggle and manual fires. The editor
// rides the same route tree (/jobs/new, /jobs/:id) as a modal on desktop and
// a full-screen form under the mobile breakpoint.
export default function JobsHome() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [lastRuns, setLastRuns] = useState<Map<number, Run>>(new Map())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Toggles in flight hold their rows out of poll results, so a poll that read
  // pre-toggle state cannot flip the checkbox back mid-request. Counted per
  // row, since a second click may overlap the first.
  const pendingToggles = useRef(new Map<number, number>())
  // Monotonic load token, so only the newest load's response applies.
  const loadToken = useRef(0)

  // Editing state derives from the route: /jobs/new or /jobs/<id>.
  const editingId =
    jobId === undefined ? undefined : jobId === 'new' ? ('new' as const) : Number(jobId)
  const editing =
    typeof editingId === 'number' && !Number.isNaN(editingId)
      ? jobs?.find((j) => j.id === editingId)
      : undefined

  // A duplicate link (/jobs/new?from=<id>) seeds the create form from a loaded
  // row: the editor fixes its draft at mount, so seeding waits for the jobs
  // load. A stale id opens plain.
  const wantsSeed = editingId === 'new' && searchParams.get('from') !== null
  const seed = useMemo(() => {
    if (!wantsSeed || jobs === null) return undefined
    const from = Number(searchParams.get('from'))
    const source = Number.isInteger(from) ? jobs.find((j) => j.id === from) : undefined
    return source === undefined ? undefined : duplicateDraft(source)
  }, [wantsSeed, searchParams, jobs])

  // Rows render soonest next fire first, display only: jobs keeps its stored
  // order for the toggle holds and editor lookups above.
  const sortedJobs = useMemo(() => (jobs ? sortJobsForDisplay(jobs) : []), [jobs])

  const load = useCallback(async () => {
    const token = ++loadToken.current
    try {
      // The newest-first history page doubles as every job's last-run status.
      const [rows, history] = await Promise.all([
        jobsApi.list(),
        runsApi.list(undefined, lastRunPage),
      ])
      if (token !== loadToken.current) return // a newer load superseded this one
      setJobs((current) => {
        const held = new Map(
          (current ?? [])
            .filter((j) => (pendingToggles.current.get(j.id) ?? 0) > 0)
            .map((j) => [j.id, j]),
        )
        if (held.size === 0) return rows
        return rows.map((j) => held.get(j.id) ?? j)
      })
      setLastRuns(new Map(history.filter((r) => r.jobId !== undefined).map((r) => [r.jobId!, r])))
      setError('')
    } catch (err) {
      if (token !== loadToken.current) return
      setError(err instanceof ApiError ? err.message : 'Loading jobs failed.')
    }
  }, [])

  // The poll's initial tick covers the mount-time load.
  usePoll(() => void load(), pollJobsMs)

  const closeEditor = useCallback(() => navigate('/jobs'), [navigate])

  const onSaved = useCallback(
    async (saved: Job | undefined) => {
      setNotice(saved !== undefined ? `Job “${saved.name}” saved.` : 'Job deleted.')
      await closeEditor()
      void load()
    },
    [closeEditor, load],
  )

  // toggle flips the row optimistically and reverts when the backend refuses.
  // After the request settles a fresh load re-syncs the row with server truth
  // (a toggle moves nextRunAt too). The row stays shielded from polls until
  // every overlapping toggle settles. Overlapping flips may end one step off,
  // so the next poll converges on the stored row.
  const toggle = async (job: Job) => {
    pendingToggles.current.set(job.id, (pendingToggles.current.get(job.id) ?? 0) + 1)
    setJobs((rows) =>
      (rows ?? []).map((j) => (j.id === job.id ? { ...j, enabled: !j.enabled } : j)),
    )
    try {
      await jobsApi.update(job.id, { ...job, enabled: !job.enabled })
      await load()
    } catch (err) {
      setJobs((rows) =>
        (rows ?? []).map((j) => (j.id === job.id ? { ...j, enabled: job.enabled } : j)),
      )
      setError(err instanceof ApiError ? err.message : 'Updating the job failed.')
    } finally {
      const left = (pendingToggles.current.get(job.id) ?? 1) - 1
      if (left <= 0) pendingToggles.current.delete(job.id)
      else pendingToggles.current.set(job.id, left)
    }
  }

  const fire = async (job: Job) => {
    try {
      const run = await jobsApi.fire(job.id)
      setNotice(`Run #${run.id} started.`)
      setError('')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Manual fire failed.')
    }
  }

  return (
    <div aria-label="Jobs">
      <JobTabs active="jobs" />

      <div className="session-header">
        <h1 style={{ margin: 0, fontSize: 'inherit' }}>Scheduled jobs</h1>
        <span className="spacer" style={{ flex: 1 }} />
        {editingId === undefined && (
          <Link to="/jobs/new">
            <button type="button" className="primary">
              New job
            </button>
          </Link>
        )}
      </div>

      {notice !== '' && (
        <p className="muted" role="status">
          {notice}
        </p>
      )}
      {error !== '' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {jobs === null && error === '' ? (
        <p className="muted">Loading jobs…</p>
      ) : jobs !== null && jobs.length === 0 && editingId === undefined ? (
        <p className="muted">No scheduled jobs yet. Create one to launch ajent on a schedule.</p>
      ) : (
        jobs !== null &&
        jobs.length > 0 && (
          <table className="jobs-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Schedule</th>
                <th>Next run</th>
                <th>Last run</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  lastRun={lastRuns.get(job.id)}
                  onToggle={() => void toggle(job)}
                  onFire={() => void fire(job)}
                />
              ))}
            </tbody>
          </table>
        )
      )}

      {typeof editingId === 'number' && Number.isNaN(editingId) ? (
        <p className="error-text">That job id is not a number.</p>
      ) : typeof editingId === 'number' && jobs !== null && editing === undefined ? (
        <p className="error-text" role="alert">
          That job no longer exists.
        </p>
      ) : jobs === null && (typeof editingId === 'number' || wantsSeed) ? (
        <p className="muted">Loading job…</p>
      ) : editingId !== undefined ? (
        <EditorWithFacts job={editing} seed={seed} onClose={closeEditor} onSaved={onSaved} />
      ) : null}
    </div>
  )
}

// EditorWithFacts gathers the picker facts the editor suggests from: known
// workspaces across live and saved sessions via the shared launch-facts hook,
// model keys and tool rows from live ones.
function EditorWithFacts({
  job,
  seed,
  onClose,
  onSaved,
}: {
  job?: Job
  seed?: JobDraft
  onClose: () => void
  onSaved: (job: Job | undefined) => Promise<void>
}) {
  const { models, workspaceOptions } = useLaunchFacts()
  const [toolOptions, setToolOptions] = useState<ToolState[]>([])

  useEffect(() => {
    let alive = true
    toolsApi
      .options()
      .then((rows) => alive && setToolOptions(rows))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // The editor suggests model keys through its free-text datalist; browsers
  // only offer plain options there, so grouping stays in the select pickers.
  return (
    <JobEditor
      job={job}
      seed={seed}
      workspaces={workspaceOptions}
      models={models.map((m) => m.key)}
      toolOptions={toolOptions}
      onSaved={onSaved}
      onCancel={onClose}
    />
  )
}

function JobRow({
  job,
  lastRun,
  onToggle,
  onFire,
}: {
  job: Job
  lastRun?: Run
  onToggle: () => void
  onFire: () => void
}) {
  const auth = useAuth()
  return (
    <tr data-testid={`job-${job.id}`}>
      <td>
        <Link to={`/jobs/${job.id}`}>{job.name}</Link>
        <div className="muted small-note">{tildePath(job.workspace, auth.home)}</div>
        {job.prompt && (
          <div className="muted small-note run-prompt-cell">{job.prompt.slice(0, 80)}</div>
        )}
      </td>
      <td>{scheduleSummary(job)}</td>
      <td>{job.enabled && job.nextRunAt ? formatSlot(job.nextRunAt, job.tz) : '—'}</td>
      <td>
        {lastRun === undefined ? (
          '—'
        ) : (
          <>
            <span className={runStatusClass(lastRun.status)}>{lastRun.status}</span>
            {lastRun.error && (
              <div className="muted small-note run-error-excerpt">{lastRun.error}</div>
            )}
          </>
        )}
      </td>
      <td>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={job.enabled}
            onChange={onToggle} // optimistic; JobsHome reverts on refusal
            aria-label={`${job.enabled ? 'Disable' : 'Enable'} ${job.name}`}
          />
          enabled
        </label>
        <div className="job-row-actions">
          <Link to={`/jobs/new?from=${job.id}`}>
            <button type="button" aria-label={`Copy ${job.name}`}>
              Copy
            </button>
          </Link>
          <button type="button" title="Run now" aria-label={`Run ${job.name} now`} onClick={onFire}>
            ▶
          </button>
        </div>
      </td>
    </tr>
  )
}
