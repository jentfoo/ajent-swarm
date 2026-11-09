import type { ActivityRow, AgentJob, AgentJobStatus, Segment } from '../api/types'

// The one sub-agent agreement. Upstream publishes one activity row per live
// job keyed `sub-N` with the job number as rank, a `subagents` status segment
// whose text carries the running/queued/done tally beside machine-readable
// counts, and keyed completion notices (ajent pkg/subagent). agents.list is
// the structured per-job read behind the stop controls, keyed by the same
// sub-N id. The live chips band, the agent tool cards and the status bar
// badge all read the same facts through here, so the surfaces never drift
// apart. The status bar's plain-row pick is the complement, defined by the
// same key filter so the two families stay in step, and both bands cap under
// one rule.

const rowPrefix = 'sub-'

// isSubAgentRow reports whether an activity row belongs to a sub-agent job.
export function isSubAgentRow(row: ActivityRow): boolean {
  return row.key.startsWith(rowPrefix)
}

// subAgentRows selects the job rows out of the snapshot's activity family in
// job order: rank is the submission number, so parallel starts that raced to
// publish still read oldest first.
export function subAgentRows(activity: ActivityRow[] | undefined): ActivityRow[] {
  return (activity ?? []).filter(isSubAgentRow).sort((a, b) => a.rank - b.rank)
}

// CappedRows is a band's visible rows plus how many fold under the overflow
// line.
export interface CappedRows {
  rows: ActivityRow[]
  overflow: number
}

// Upstream's bands paint at most four rows plus one overflow line, and the
// line names two or more hidden rows only: a lone hidden row takes its place
// and is listed instead (ajent docs/tui-design.md, activity section).
const bandCap = 4

// capRows applies that cap to display-ordered rows: the head stays visible,
// the tail hides under the overflow count.
export function capRows(rows: ActivityRow[]): CappedRows {
  if (rows.length <= bandCap) return { rows, overflow: 0 }
  const visible = rows.length <= bandCap + 1 ? rows.length : bandCap
  return { rows: rows.slice(0, visible), overflow: rows.length - visible }
}

// barActivity picks the status bar's plain activity rows: everything outside
// the sub-agent family, newest first so the line leads with the work in
// flight and width pressure clips the oldest, capped like upstream's band.
// Each family hands its rows oldest first, so the plain rows reverse.
export function barActivity(activity: ActivityRow[] | undefined): CappedRows {
  const rows = (activity ?? []).filter((row) => !isSubAgentRow(row)).reverse()
  return capRows(rows)
}

// SubAgentCall is the slice of a tool call the own-row filter reads.
interface SubAgentCall {
  name?: string
  input?: unknown
  result?: unknown
  closed?: boolean // the turn ended before a result arrived
}

// cardSubAgentRow resolves the one row an agent_poll card renders: the job the
// call waits on, named by its id argument, and only while the call still
// waits. A landed result hides the line, a poll timeout included. An
// agent_start learns its job id from its own result text alone, so a start
// card never has a row to show.
export function cardSubAgentRow(call: SubAgentCall, rows: ActivityRow[]): ActivityRow | undefined {
  if (call.name !== 'agent_poll') return undefined
  if (call.result !== undefined || call.closed === true) return undefined
  const key = pollJobKey(call.input)
  return rows.find((row) => row.key === key)
}

// pollJobKey reads a poll call's id argument as a row key, accepting upstream's
// bare-number ids (sub-2 or 2) and the double-encoded arguments models
// sometimes send (see editInput.ts). '' when unreadable.
function pollJobKey(input: unknown): string {
  let args: unknown = input
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown
    } catch {
      return ''
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return ''
  const id = (args as Record<string, unknown>).id
  if (typeof id !== 'string') return ''
  const trimmed = id.trim()
  return trimmed === '' || trimmed.startsWith(rowPrefix) ? trimmed : rowPrefix + trimmed
}

// SegmentCounts is the status-segment tally vocabulary: running, queued and
// done, matching the subagents segment's prose.
interface SegmentCounts {
  running: number
  queued: number
  done: number
}

// segmentCounts reads the tally the structured way when the segment carries
// counts, demoting to the prose parse only for a pre-12a ajent that publishes
// text alone. A wording drift then loses precision instead of lying.
function segmentCounts(segment: Segment | undefined): SegmentCounts {
  const counts = segment?.counts
  if (counts !== undefined) {
    return {
      running: counts.running ?? 0,
      queued: counts.queued ?? 0,
      done: counts.done ?? 0,
    }
  }
  return parseSegmentTally(segment?.text)
}

// SubAgentTally is the status bar badge's count set. Live jobs count from the
// activity rows, the ground truth every terminal path clears, completions
// read the structured counts when the segment carries them.
interface SubAgentTally {
  active: number
  done: number
  rows: ActivityRow[] // the job rows behind active, for the badge's tooltip
  segment?: Segment // upstream's published tally, rendered raw when nothing reads
}

// subAgentTally derives the badge counts: live rows first, structured counts
// over the prose parse, which survives only as the pre-12a fallback.
export function subAgentTally(
  activity: ActivityRow[] | undefined,
  segments: Segment[] | undefined,
): SubAgentTally {
  const segment = (segments ?? []).find((s) => s.key === segmentKey && s.text !== '')
  const counts = segmentCounts(segment)
  const rows = subAgentRows(activity)
  return {
    active: rows.length > 0 ? rows.length : counts.running + counts.queued,
    done: counts.done,
    rows,
    segment,
  }
}

// jobsLive reports whether sub-agent work is in flight: live rows or a
// nonzero running/queued tally. This is the pull condition for agents.list,
// so a finished batch (done-only tallies) never keeps the poller running.
export function jobsLive(
  activity: ActivityRow[] | undefined,
  segments: Segment[] | undefined,
): boolean {
  return subAgentTally(activity, segments).active > 0
}

const segmentKey = 'subagents'

// parseSegmentTally reads the counts out of upstream's published wording
// ("subagents: 2 running (oldest 30s), 1 queued, 4 done"). The pre-12a
// fallback: missing parts degrade to zero.
function parseSegmentTally(text: string | undefined): SegmentCounts {
  const count = (re: RegExp) => Number(re.exec(text ?? '')?.[1] ?? 0)
  return {
    running: count(/(\d+) running/),
    queued: count(/(\d+) queued/),
    done: count(/(\d+) done/),
  }
}

// stoppableJob reports whether a stop belongs on a job: only queued and
// running work offers one, so a finished-job refusal stays an error surface
// rather than a button. A visible row is in-flight by the row lifetime rule
// (every terminal path clears it), so a job missing its record still stops.
export function stoppableJob(job: AgentJob | undefined): boolean {
  return job === undefined || job.status === 'queued' || job.status === 'running'
}

// agentJobStatusClass maps a job's status onto the badge color classes
// unknown statuses render plain, since vocabulary additions are additive.
export function agentJobStatusClass(status: AgentJobStatus): string {
  switch (status) {
    case 'running':
      return 'accent'
    case 'done':
      return 'ok'
    case 'error':
      return 'danger'
    case 'aborted':
      return 'warn'
    default:
      return ''
  }
}

// formatElapsed renders a job's elapsed time compactly (45s, 2m05s, 1h03m)
// absent or negative elapsed reads empty.
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return ''
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const two = (v: number) => String(v).padStart(2, '0')
  const mins = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)
  if (hours > 0) return `${hours}h${two(mins % 60)}m`
  return `${mins}m${two(secs % 60)}s`
}
