import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { ApiError } from '../api/client'
import { jobsApi, runsApi, tools as toolsApi } from '../api/endpoints'
import type { Job, Run, ToolState } from '../api/types'
import { useLaunchFacts } from '../hooks/useLaunchFacts'
import { usePoll } from '../hooks/usePoll'
import { mobileLayout, useMediaQuery } from '../hooks/useMediaQuery'
import { useAuth } from '../providers/auth'
import { tildePath } from '../session/names'
import { JobEditor } from '../jobs/JobEditor'
import { QueueComposer } from '../jobs/QueueComposer'
import { duplicateDraft } from '../jobs/jobDraft'
import type { JobDraft } from '../jobs/jobDraft'
import { JobTabs } from '../jobs/JobTabs'
import { formatSlot, runStatusClass, scheduleSummary, sortJobsForDisplay } from '../jobs/schedule'

const pollJobsMs = 10_000
// A page deep enough that every job's latest run is on it for most installs.
const lastRunPage = 200

// JobsHome lists scheduled jobs over /api/jobs: plain-language schedules,
// next fire times, an optimistic enabled toggle and manual fires. Each row's
// display data derives once and renders twice: the desktop table above the
// shared 48rem breakpoint (hooks/useMediaQuery.mobileLayout), stacked cards
// below it. The editor rides the same route tree (/jobs/new, /jobs/:id) as a
// modal on desktop and a full-screen form under the mobile breakpoint.
export default function JobsHome() {
  const { jobId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const mobile = useMediaQuery(mobileLayout)
  const { home } = useAuth()

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

  // Editing state derives from the route: /jobs/new, /jobs/queue or /jobs/<id>.
  // The fixed routes ride the :jobId param the same way 'new' always has, so
  // both AuthGate trees serve them without extra registrations.
  const editingId =
    jobId === undefined || jobId === 'new' || jobId === 'queue' ? jobId : Number(jobId)
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

  // The editor fixes its draft at mount, so its key covers every draft source:
  // the edited job id, or the duplicate seed's from param. A direct route swap
  // (/jobs/5 -> /jobs/7, or one seed for another) then remounts the form with
  // the new target's values instead of saving one row onto another. Normal
  // in-app navigation closes through /jobs, which unmounts.
  const editorKey = editingId === 'new' ? `new?from=${searchParams.get('from') ?? ''}` : editingId

  // Rows render soonest next fire first, display only: jobs keeps its stored
  // order for the toggle holds and editor lookups above.
  const sortedJobs = useMemo(() => (jobs ? sortJobsForDisplay(jobs) : []), [jobs])

  // One derivation feeds both presentations, so a phone card can never show a
  // fact the table row would have rendered differently. The breakpoint swap is
  // presentational only: state, polling and actions live in JobsHome itself.
  const rows = useMemo(
    () => sortedJobs.map((job) => ({ job, facts: jobRowFacts(job, home, lastRuns.get(job.id)) })),
    [sortedJobs, home, lastRuns],
  )

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
      setLastRuns(latestRunByJob(history))
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

  const onQueued = useCallback(
    async (job: Job) => {
      setNotice(`Queued “${job.name}”.`)
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
          <>
            <Link to="/jobs/queue">
              <button type="button">Queue</button>
            </Link>
            <Link to="/jobs/new">
              <button type="button" className="primary">
                New job
              </button>
            </Link>
          </>
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
        <p className="muted">
          No scheduled jobs yet. Create one to launch ajent on a schedule, or queue a single prompt
          for the next idle moment.
        </p>
      ) : jobs !== null && jobs.length > 0 ? (
        mobile ? (
          <div className="job-cards" role="list">
            {rows.map(({ job, facts }) => (
              <JobCard
                key={job.id}
                job={job}
                facts={facts}
                onToggle={() => void toggle(job)}
                onFire={() => void fire(job)}
              />
            ))}
          </div>
        ) : (
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
              {rows.map(({ job, facts }) => (
                <JobTableRow
                  key={job.id}
                  job={job}
                  facts={facts}
                  onToggle={() => void toggle(job)}
                  onFire={() => void fire(job)}
                />
              ))}
            </tbody>
          </table>
        )
      ) : null}

      {typeof editingId === 'number' && Number.isNaN(editingId) ? (
        <p className="error-text">That job id is not a number.</p>
      ) : typeof editingId === 'number' && jobs !== null && editing === undefined ? (
        <p className="error-text" role="alert">
          That job no longer exists.
        </p>
      ) : jobs === null && (typeof editingId === 'number' || wantsSeed) ? (
        <p className="muted">Loading job…</p>
      ) : editingId === 'queue' ? (
        <QueueWithFacts onClose={closeEditor} onQueued={onQueued} />
      ) : editingId !== undefined ? (
        <EditorWithFacts
          key={editorKey}
          job={editing}
          seed={seed}
          onClose={closeEditor}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  )
}

// latestRunByJob reduces a runs page to each job's newest run for the Last
// run badge. The page can hold several runs of one job, and ids increase,
// so the highest id per job is its latest regardless of row order.
function latestRunByJob(runs: Run[]): Map<number, Run> {
  const latest = new Map<number, Run>()
  for (const r of runs) {
    if (r.jobId === undefined) continue
    const seen = latest.get(r.jobId)
    if (seen === undefined || r.id > seen.id) latest.set(r.jobId, r)
  }
  return latest
}

// useJobFacts gathers the picker facts the job forms suggest from: known
// workspaces across live and saved sessions via the shared launch-facts hook,
// model keys and tool rows from live ones.
function useJobFacts() {
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

  return { models: models.map((m) => m.key), workspaceOptions, toolOptions }
}

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
  const facts = useJobFacts()

  // The editor suggests model keys through its free-text datalist; browsers
  // only offer plain options there, so grouping stays in the select pickers.
  return (
    <JobEditor
      job={job}
      seed={seed}
      workspaces={facts.workspaceOptions}
      models={facts.models}
      toolOptions={facts.toolOptions}
      onSaved={onSaved}
      onCancel={onClose}
    />
  )
}

function QueueWithFacts({
  onClose,
  onQueued,
}: {
  onClose: () => void
  onQueued: (job: Job) => Promise<void>
}) {
  const facts = useJobFacts()
  return (
    <QueueComposer
      workspaces={facts.workspaceOptions}
      models={facts.models}
      toolOptions={facts.toolOptions}
      onQueued={onQueued}
      onCancel={onClose}
    />
  )
}

// Excerpt pairs a row's clipped text with what the clip hides, so every
// presentation carries the same tooltip.
type Excerpt = {
  text: string
  title: string
}

// JobRowFacts is one job's display data shared by the desktop table row and
// the phone card, derived once per load so the two layouts cannot drift.
type JobRowFacts = {
  path: string
  prompt?: Excerpt
  queued: boolean
  scheduleText: string
  nextRunText: string
  lastStatus?: { label: string; className: string }
  errorExcerpt?: Excerpt
}

// jobRowFacts reduces a job and its newest run to the strings both layouts
// render: tilde workspace, prompt excerpt, cadence or queued badge, next slot
// and last outcome. A disabled or unscheduled row shows an em dash slot.
function jobRowFacts(job: Job, home: string | undefined, lastRun?: Run): JobRowFacts {
  return {
    path: tildePath(job.workspace, home),
    prompt: job.prompt ? { text: job.prompt.slice(0, 80), title: job.prompt } : undefined,
    queued: Boolean(job.queued),
    scheduleText: scheduleSummary(job),
    nextRunText: job.queued
      ? job.nextRunAt
        ? 'when idle'
        : '—'
      : job.enabled && job.nextRunAt
        ? formatSlot(job.nextRunAt, job.tz)
        : '—',
    lastStatus:
      lastRun === undefined
        ? undefined
        : { label: lastRun.status, className: runStatusClass(lastRun.status) },
    errorExcerpt: lastRun?.error ? { text: lastRun.error, title: lastRun.error } : undefined,
  }
}

type JobRowProps = {
  job: Job
  facts: JobRowFacts
  onToggle: () => void
  onFire: () => void
}

// JobExcerpt renders one clipped row line with the full text as its tooltip.
function JobExcerpt({ className, excerpt }: { className: string; excerpt: Excerpt }) {
  return (
    <div className={`muted small-note ${className}`} title={excerpt.title}>
      {excerpt.text}
    </div>
  )
}

// JobToggle is the optimistic enabled switch; JobsHome reverts on refusal.
function JobToggle({ job, onToggle }: { job: Job; onToggle: () => void }) {
  return (
    <label className="toggle-row">
      <input
        type="checkbox"
        checked={job.enabled}
        onChange={onToggle}
        aria-label={`${job.enabled ? 'Disable' : 'Enable'} ${job.name}`}
      />
      enabled
    </label>
  )
}

function JobTableRow({ job, facts, onToggle, onFire }: JobRowProps) {
  return (
    <tr data-testid={`job-${job.id}`}>
      <td>
        <Link to={`/jobs/${job.id}`}>{job.name}</Link>
        <div className="muted small-note">{facts.path}</div>
        {facts.prompt && <JobExcerpt className="run-prompt-cell" excerpt={facts.prompt} />}
      </td>
      <td>{facts.queued ? <span className="badge accent">queued</span> : facts.scheduleText}</td>
      <td>{facts.nextRunText}</td>
      <td>
        {facts.lastStatus === undefined ? (
          '—'
        ) : (
          <>
            <span className={facts.lastStatus.className}>{facts.lastStatus.label}</span>
            {facts.errorExcerpt && (
              <JobExcerpt className="run-error-excerpt" excerpt={facts.errorExcerpt} />
            )}
          </>
        )}
      </td>
      <td>
        <JobToggle job={job} onToggle={onToggle} />
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

// JobCard is the phone presentation: one stacked card per job wearing the
// switcher rows' touch language — last-run status beside the label, 44px
// action floors — with labeled lines standing in for the table headers.
function JobCard({ job, facts, onToggle, onFire }: JobRowProps) {
  return (
    <div className="job-card" role="listitem" data-testid={`job-${job.id}`}>
      <span className="switch-top">
        <span className="switch-name">{job.name}</span>
        {facts.lastStatus && (
          <span className={facts.lastStatus.className}>{facts.lastStatus.label}</span>
        )}
      </span>
      <div className="muted small-note">{facts.path}</div>
      {facts.prompt && <JobExcerpt className="run-prompt-cell" excerpt={facts.prompt} />}
      {/* the schedule cell's badge-or-summary beside the next-run slot, with a
          label since phones have no column headers to read them from */}
      <div className="job-card-when">
        {facts.queued ? <span className="badge accent">queued</span> : facts.scheduleText}
        <span className="muted">Next run: {facts.nextRunText}</span>
      </div>
      {facts.errorExcerpt && (
        <JobExcerpt className="run-error-excerpt" excerpt={facts.errorExcerpt} />
      )}
      {/* switch-actions carries the 44px floors and wrap; the toggle joins it
          so every card control sits in one touch-sized action row */}
      <div className="switch-actions">
        <JobToggle job={job} onToggle={onToggle} />
        <Link to={`/jobs/new?from=${job.id}`}>
          <button type="button" aria-label={`Copy ${job.name}`}>
            Copy
          </button>
        </Link>
        <button type="button" aria-label={`Run ${job.name} now`} onClick={onFire}>
          Run
        </button>
        <Link to={`/jobs/${job.id}`}>
          <button type="button" aria-label={`Edit ${job.name}`}>
            Edit
          </button>
        </Link>
      </div>
    </div>
  )
}
