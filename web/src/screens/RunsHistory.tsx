import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { jobsApi, runsApi } from '../api/endpoints'
import type { Job, Run, RunStatus } from '../api/types'
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

const pollRunsMs = 10_000

// RunHistory is the filterable table over /api/runs: by job through the
// backend's ?job= parameter, by status client-side. Clicking a row explains
// what happened without opening logs. The detail modal resolves its run from
// the latest list, so each poll refreshes it in place.
export default function RunsHistory() {
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
        setError(err instanceof ApiError ? err.message : 'Loading run history failed.')
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

  const visible = useMemo(
    () => (runs ?? []).filter((r) => statusFilter === '' || r.status === statusFilter),
    [runs, statusFilter],
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
      ) : visible.length === 0 && runs !== null && runs.length > 0 ? (
        <p className="muted">No runs match these filters.</p>
      ) : (
        runs !== null &&
        visible.length > 0 && (
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
              {visible.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className="run-row"
                  data-testid={`run-${r.id}`}
                >
                  <td title={formatTimestamp(r.startedAt)}>
                    {relativeTimestamp(r.startedAt, now)}
                  </td>
                  <td>{jobName(r) || '—'}</td>
                  <td>
                    <span className={runStatusClass(r.status)}>{r.status}</span>
                    {r.error && (
                      <div className="muted small-note run-error-excerpt" title={r.error}>
                        {r.error}
                      </div>
                    )}
                  </td>
                  <td>{formatDuration(r.startedAt, r.finishedAt)}</td>
                  <td className="run-prompt-cell" title={r.prompt || undefined}>
                    {(r.prompt ?? '').slice(0, 80) || '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setSelectedId(r.id)
                      }}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {selected && <RunDetail run={selected} onClose={() => setSelectedId(undefined)} />}
    </div>
  )
}

const runStatuses: RunStatus[] = ['running', 'awaiting_input', 'ok', 'failed', 'timeout', 'skipped']
