import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { ApiError } from '../api/client'
import { fleet, jobsApi, models as modelsApi, runsApi } from '../api/endpoints'
import type { Job, Run, SavedSession } from '../api/types'
import { usePoll } from '../hooks/usePoll'
import { useAuth } from '../providers/auth'
import { useSwarm } from '../providers/swarm'
import { tildePath } from '../session/names'
import { JobEditor } from '../jobs/JobEditor'
import { JobTabs } from '../jobs/JobTabs'
import { formatSlot, runStatusClass, scheduleSummary } from '../jobs/schedule'

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

  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [lastRuns, setLastRuns] = useState<Map<number, Run>>(new Map())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Editing state derives from the route: /jobs/new or /jobs/<id>.
  const editingId = useMemo(() => {
    if (jobId === undefined) return undefined
    return jobId === 'new' ? ('new' as const) : Number(jobId)
  }, [jobId])
  const editing =
    typeof editingId === 'number' && !Number.isNaN(editingId)
      ? jobs?.find((j) => j.id === editingId)
      : undefined

  const load = useCallback(async () => {
    try {
      // The newest-first history page doubles as every job's last-run status.
      const [rows, history] = await Promise.all([
        jobsApi.list(),
        runsApi.list(undefined, lastRunPage),
      ])
      setJobs(rows)
      setLastRuns(new Map(history.filter((r) => r.jobId !== undefined).map((r) => [r.jobId!, r])))
      setError('')
    } catch (err) {
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
  const toggle = async (job: Job) => {
    setJobs((rows) =>
      (rows ?? []).map((j) => (j.id === job.id ? { ...j, enabled: !j.enabled } : j)),
    )
    try {
      await jobsApi.update(job.id, { ...job, enabled: !job.enabled })
    } catch (err) {
      setJobs((rows) =>
        (rows ?? []).map((j) => (j.id === job.id ? { ...j, enabled: job.enabled } : j)),
      )
      setError(err instanceof ApiError ? err.message : 'Updating the job failed.')
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
              {jobs.map((job) => (
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
      ) : typeof editingId === 'number' && jobs === null ? (
        <p className="muted">Loading job…</p>
      ) : editingId !== undefined ? (
        <EditorWithFacts job={editing} onClose={closeEditor} onSaved={onSaved} />
      ) : null}
    </div>
  )
}

// EditorWithFacts gathers the picker facts the editor suggests from: known
// workspaces across live and saved sessions, model keys from live ones.
function EditorWithFacts({
  job,
  onClose,
  onSaved,
}: {
  job?: Job
  onClose: () => void
  onSaved: (job: Job | undefined) => Promise<void>
}) {
  const { sessions } = useSwarm()
  const [savedRows, setSavedRows] = useState<SavedSession[]>([])
  const [models, setModels] = useState<string[]>([])

  // Suggestion sources load once; the live listing joins at render time.
  useEffect(() => {
    let alive = true
    fleet
      .saved()
      .then((rows) => alive && setSavedRows(rows))
      .catch(() => {}) // best effort
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    modelsApi
      .list()
      .then((rows) => alive && setModels([...new Set(rows.map((r) => r.current.key))].sort()))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const workspaces = useMemo(() => {
    const seen: string[] = []
    for (const s of [...sessions, ...savedRows]) {
      if (s.workspace && !seen.includes(s.workspace)) seen.push(s.workspace)
    }
    return seen
  }, [sessions, savedRows])

  return (
    <JobEditor
      job={job}
      workspaces={workspaces}
      models={models}
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
            aria-label={`Enable ${job.name}`}
          />
          enabled
        </label>{' '}
        <button type="button" onClick={onFire}>
          Run now
        </button>
      </td>
    </tr>
  )
}
