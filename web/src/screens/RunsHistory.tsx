import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { describeError } from '../api/errors'
import { jobsApi, runsApi } from '../api/endpoints'
import type { Job, Run, RunStatus } from '../api/types'
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

const runStatuses: RunStatus[] = ['running', 'awaiting_input', 'ok', 'failed', 'timeout', 'skipped']

// RunsHistory is the filterable history over /api/runs: by job through the
// backend's ?job= parameter, by status client-side. Each row's display data
// derives once and renders twice: the desktop table above the shared 48rem
// breakpoint (hooks/useMediaQuery.mobileLayout), stacked cards below it.
// Clicking a row explains what happened without opening logs. The detail modal
// resolves its run from the latest list, so each poll refreshes it in place.
export default function RunsHistory() {
  const mobile = useMediaQuery(mobileLayout)
  const [jobs, setJobs] = useState<Job[]>([])
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState('')
  const [jobFilter, setJobFilter] = useState<number | ''>('')
  const [statusFilter, setStatusFilter] = useState<'' | RunStatus>('')
  const [selectedId, setSelectedId] = useState<number | undefined>(undefined)

  // Each load aborts its predecessor and only the newest may commit state:
  // a poll tick racing a filter change would otherwise let last-resolved win
  // and paint one job's rows under another's select.
  const loadSeq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => abortRef.current?.abort(), [])

  // The explicit job filter takes the value so a change reloads at once; the
  // poll's initial tick covers the mount-time load and later cadence ticks
  // read the latest filter through the callback ref.
  const load = useCallback(
    async (jobId: number | '' = jobFilter) => {
      const seq = ++loadSeq.current
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const [rows, jobRows] = await Promise.all([
          runsApi.list(jobId === '' ? undefined : jobId, 200, controller.signal),
          jobsApi.list(controller.signal),
        ])
        if (controller.signal.aborted || seq !== loadSeq.current) return // superseded
        setRuns(rows ?? []) // a null body reads as an empty history
        setJobs(jobRows ?? [])
        setError('')
      } catch (err) {
        if (controller.signal.aborted || seq !== loadSeq.current) return // superseded
        setError(describeError(err, 'Loading run history failed.'))
      }
    },
    [jobFilter],
  )

  usePoll(() => void load(), pollRunsMs)

  // The Started column reads as a recency label, so it needs its own clock:
  // a failed poll would otherwise leave every age frozen.
  const now = useNow(30_000)

  const jobName = useCallback(
    (run: Run) => jobs.find((j) => j.id === run.jobId)?.name ?? '',
    [jobs],
  )

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
        <h1 style={{ margin: 0, fontSize: 'inherit' }}>Run history</h1>
        <span className="spacer" style={{ flex: 1 }} />
        <label className="runs-filter">
          Job{' '}
          <select
            value={jobFilter}
            onChange={(ev) => {
              const v = ev.target.value === '' ? ('' as const) : Number(ev.target.value)
              setJobFilter(v)
              void load(v)
            }}
          >
            <option value="">All jobs</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </label>
        <label className="runs-filter">
          Status{' '}
          <select
            value={statusFilter}
            onChange={(ev) => setStatusFilter(ev.target.value as '' | RunStatus)}
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

      {runs !== null && runs.length === 0 ? (
        <p className="muted">No runs yet. Fire a job or wait for its schedule.</p>
      ) : rows.length === 0 && runs !== null && runs.length > 0 ? (
        <p className="muted">No runs match these filters.</p>
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

// OpenDetailButton is the keyboard path onto one run's detail in both layouts;
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
// back peels the modal instead of leaving /jobs/runs and dropping filters;
// the shared RunDetail itself stays desktop-neutral.
function RunDetailLayer({ run, onClose }: { run: Run; onClose: () => void }): ReactElement {
  useOverlayBack(onClose)
  return <RunDetail run={run} onClose={onClose} />
}
