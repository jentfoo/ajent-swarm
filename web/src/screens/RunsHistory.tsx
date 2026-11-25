import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useSearchParams } from 'react-router'
import { describeError } from '../api/errors'
import { jobsApi, runsApi } from '../api/endpoints'
import type { Job, Run, RunStatus } from '../api/types'
import { runStatuses } from '../api/types'
import { mobileLayout, useMediaQuery } from '../hooks/useMediaQuery'
import { useNow } from '../hooks/useNow'
import { usePoll } from '../hooks/usePoll'
import { JobTabs } from '../jobs/JobTabs'
import {
  runStatusClass,
  formatDuration,
  formatTimestamp,
  relativeTimestamp,
} from '../jobs/schedule'
import { RunDetail } from '../jobs/RunDetail'
import { useOverlayBack } from '../ui/useOverlayBack'

const pollRunsMs = 10_000

// RunsHistory is the filterable history over /api/runs: by job through the
// backend's ?job= parameter, by status client-side. Both filters live in the
// URL search parameters, so a filtered view reloads, bookmarks and shares, and
// a job row's Last run cell deep-links straight into it. Each row's display
// data derives once and renders twice: the desktop table above the shared 48rem
// breakpoint (hooks/useMediaQuery.mobileLayout), stacked cards below it.
// Clicking a row explains what happened without opening logs. The detail modal
// resolves its run from the latest list, so each poll refreshes it in place.
export default function RunsHistory() {
  const mobile = useMediaQuery(mobileLayout)
  const [searchParams, setSearchParams] = useSearchParams()
  const [jobs, setJobs] = useState<Job[]>([])
  const [jobsLoaded, setJobsLoaded] = useState(false)
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined)
  // the URL is the filter state, validated once so a hand-edited link can
  // neither request NaN nor filter on an unknown status
  const jobFilter = parseJobFilter(searchParams.get('job'))
  const statusFilter = parseStatusFilter(searchParams.get('status'))

  // Each load aborts its predecessor and only the newest may commit state:
  // a poll tick racing a filter change would otherwise let last-resolved win
  // and paint one job's rows under another's select.
  const loadSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])

  // History is the primary read and job names auxiliary: one failing never
  // masks the other, each branch applies only after the recency check. Loads
  // pass the job filter explicitly so a change reloads under its own value,
  // the poll reads the latest filter through the callback ref.
  const load = useCallback(
    async (jobId: number | '' = jobFilter) => {
      const seq = ++loadSeq.current
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const [runsRes, jobsRes] = await Promise.allSettled([
        runsApi.list(jobId === '' ? undefined : jobId, 200, controller.signal),
        jobsApi.list(controller.signal),
      ])
      if (controller.signal.aborted || seq !== loadSeq.current) return // superseded
      if (runsRes.status === 'fulfilled') {
        setRuns(runsRes.value ?? []) // a null body reads as an empty history
        setError('')
      } else {
        setError(describeError(runsRes.reason, 'Loading run history failed.'))
      }
      // a refused names read keeps the current labels, rows stay on their dash
      // until the next poll lands it
      if (jobsRes.status === 'fulfilled') {
        setJobs(jobsRes.value ?? [])
        setJobsLoaded(true)
      }
    },
    [jobFilter],
  )

  // setFilters rewrites the two params with replace: only non-defaults
  // serialize so the plain route stays clean, and filter edits never grow the
  // browser-back trail under the poll. The route defines no other parameters.
  const setFilters = useCallback(
    (job: number | '', status: '' | RunStatus) => {
      const next = new URLSearchParams()
      if (job !== '') next.set('job', String(job))
      if (status !== '') next.set('status', status)
      setSearchParams(next, { replace: true })
    },
    [setSearchParams],
  )

  // One path reloads on every actual job change, select edits and history
  // navigation alike, while the poll's initial tick covers the mount-time load
  // (this ref is seeded at mount) and later cadence ticks read the latest
  // filter through the callback ref.
  const loadedJobRef = useRef(jobFilter)
  useEffect(() => {
    if (loadedJobRef.current === jobFilter) return
    loadedJobRef.current = jobFilter
    void load(jobFilter)
  }, [jobFilter, load])

  usePoll(() => void load(), pollRunsMs)

  // The Started column reads as a recency label, so it needs its own clock:
  // a failed poll would otherwise leave every age frozen.
  const now = useNow(30_000)

  const jobName = useCallback(
    (run: Run) => jobs.find((j) => j.id === run.jobId)?.name ?? '',
    [jobs],
  )
  // the filter's own job name for the empty copy, unknown until its row loads
  const filterJobName =
    jobFilter === '' ? undefined : (jobs.find((j) => j.id === jobFilter)?.name ?? 'this job')

  // Resolution by id keeps the modal off a frozen snapshot: status, finished
  // time and error track each poll. A run that left the history closes it.
  const selected = useMemo(() => (runs ?? []).find((r) => r.id === selectedId), [runs, selectedId])

  // One derivation filters and feeds both presentations, so a phone card can
  // never show a fact the table row would have rendered differently. The
  // breakpoint swap is presentational only: state, polling and the modal live
  // here.
  const rows = useMemo(
    () =>
      (runs ?? [])
        .filter((run) => statusFilter === '' || run.status === statusFilter)
        .map((run) => ({ run, facts: runRowFacts(run, jobName(run), now) })),
    [runs, statusFilter, jobName, now],
  )

  return (
    <div aria-label="Run history">
      <JobTabs active="runs" />

      <div className="session-header">
        <h1 className="page-title">Run history</h1>
        <span className="spacer" style={{ flex: 1 }} />
        <label className="runs-filter">
          Job{' '}
          <select
            value={jobFilter}
            onChange={(ev) => setFilters(parseJobFilter(ev.target.value), statusFilter)}
          >
            <option value="">All jobs</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
            {/* a deep-linked id keeps its slot: bare until the names load,
                then a truthful gone label instead of silently reading All */}
            {jobFilter !== '' && !jobs.some((j) => j.id === jobFilter) && (
              <option value={jobFilter}>
                {jobsLoaded ? `#${jobFilter} (deleted)` : `#${jobFilter}`}
              </option>
            )}
          </select>
        </label>
        <label className="runs-filter">
          Status{' '}
          <select
            value={statusFilter}
            onChange={(ev) => setFilters(jobFilter, parseStatusFilter(ev.target.value))}
          >
            <option value="">All</option>
            {runStatuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error !== '' && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {/* gated on no error so a failed first load keeps its alert alone,
          never a loading line under it */}
      {runs === null && error === '' ? (
        <p className="muted">Loading run history…</p>
      ) : runs !== null && rows.length === 0 ? (
        <p className="muted">{runEmptyCopy(filterJobName, statusFilter)}</p>
      ) : rows.length > 0 ? (
        mobile ? (
          <div className="run-cards" role="list">
            {rows.map(({ run, facts }) => (
              <RunCard key={run.id} run={run} facts={facts} onOpen={() => setSelectedId(run.id)} />
            ))}
          </div>
        ) : (
          <div className="runs-scroll">
            <table className="runs-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Job</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Prompt</th>
                  <th aria-label="Details" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ run, facts }) => (
                  <RunTableRow
                    key={run.id}
                    run={run}
                    facts={facts}
                    onOpen={() => setSelectedId(run.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {selected && <RunDetailLayer run={selected} onClose={() => setSelectedId(undefined)} />}
    </div>
  )
}

// parseJobFilter validates a ?job= value onto a job id: ids are positive
// integers, so any other spelling reads as All and never requests NaN.
function parseJobFilter(raw: string | null): number | '' {
  if (raw === null) return ''
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : ''
}

// parseStatusFilter validates ?status= onto the stored status union, unknown
// values fall back to All rather than a filter nothing can match.
function parseStatusFilter(raw: string | null): '' | RunStatus {
  return raw !== null && (runStatuses as readonly string[]).includes(raw) ? (raw as RunStatus) : ''
}

// runEmptyCopy names the empty scope: global absence, one job's history, or a
// status miss over the fetched rows. The client reads only the latest window,
// so a filter miss never claims older matching runs do not exist.
function runEmptyCopy(job: string | undefined, status: string): string {
  if (status !== '') {
    return job === undefined
      ? `No ${status} runs in the latest history.`
      : `No ${status} runs for ${job} in the latest history.`
  }
  if (job !== undefined) return `No runs for ${job} yet. Fire it or wait for its schedule.`
  return 'No runs yet. Fire a job or wait for its schedule.'
}

// RunRowFacts is one run's display data shared by the desktop table row and
// the phone card, derived once per row so the two layouts cannot drift.
type RunRowFacts = {
  jobName: string
  startedLabel: string
  startedTitle: string
  status: { label: string; className: string }
  durationText: string
  prompt: string
  error: string
}

// runRowFacts reduces one run and its job's name to the strings both layouts
// render: recency label with the zone-suffixed absolute behind it, badge
// status, wall-clock span, then the prompt and error in full. The table cells
// clip those, the card wraps them.
function runRowFacts(run: Run, job: string, now: number): RunRowFacts {
  return {
    jobName: job,
    startedLabel: relativeTimestamp(run.startedAt, now),
    startedTitle: formatTimestamp(run.startedAt),
    status: { label: run.status, className: runStatusClass(run.status) },
    durationText: formatDuration(run.startedAt, run.finishedAt),
    prompt: run.prompt ?? '',
    error: run.error ?? '',
  }
}

type RunRowProps = {
  run: Run
  facts: RunRowFacts
  onOpen: () => void
}

// OpenDetailButton is the keyboard path onto one run's detail in both layouts
// the table keeps it inline while the card's action row gives it a 44px floor.
function OpenDetailButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation()
        onOpen()
      }}
    >
      Details
    </button>
  )
}

function RunTableRow({ run, facts, onOpen }: RunRowProps) {
  return (
    <tr className="run-row" onClick={onOpen} data-testid={`run-${run.id}`}>
      <td title={facts.startedTitle}>{facts.startedLabel}</td>
      <td>{facts.jobName || '—'}</td>
      <td>
        <span className={facts.status.className}>{facts.status.label}</span>
        {facts.error !== '' && (
          <div className="muted small-note run-error-excerpt" title={facts.error}>
            {facts.error}
          </div>
        )}
      </td>
      <td>{facts.durationText}</td>
      <td className="run-prompt-cell" title={facts.prompt || undefined}>
        {facts.prompt.slice(0, 80) || '—'}
      </td>
      <td>
        <OpenDetailButton onOpen={onOpen} />
      </td>
    </tr>
  )
}

// RunCard is the phone presentation: one stacked card per run wearing the
// switcher rows' touch language, status beside the job's name and labeled
// lines standing in for the table headers, with the prompt and error wrapping
// in full where the table clips them. The card opens the detail like a row.
function RunCard({ run, facts, onOpen }: RunRowProps) {
  return (
    <div className="run-card" role="listitem" data-testid={`run-${run.id}`} onClick={onOpen}>
      <span className="switch-top">
        <span className="switch-name">{facts.jobName || '—'}</span>
        <span className={facts.status.className}>{facts.status.label}</span>
      </span>
      {/* phones have no column headers, so the Started and Duration cells read
          as labeled lines; the recency label keeps its absolute behind it */}
      <div className="run-card-when">
        <span className="muted" title={facts.startedTitle}>
          Started: {facts.startedLabel}
        </span>
        <span className="muted">Duration: {facts.durationText}</span>
      </div>
      {facts.prompt !== '' && <p className="run-card-text">{facts.prompt}</p>}
      {facts.error !== '' && <p className="muted small-note run-card-text">{facts.error}</p>}
      {/* switch-actions carries the 44px touch floor shared with the switcher
          rows, so the card's one control sits in a touch-sized action row */}
      <div className="switch-actions">
        <OpenDetailButton onOpen={onOpen} />
      </div>
    </div>
  )
}

// RunDetailLayer mounts the open detail as its own history layer, so platform
// back peels the modal instead of leaving /jobs/runs and dropping filters
// the shared RunDetail itself stays desktop-neutral.
function RunDetailLayer({ run, onClose }: { run: Run; onClose: () => void }): ReactElement {
  useOverlayBack(onClose)
  return <RunDetail run={run} onClose={onClose} />
}
