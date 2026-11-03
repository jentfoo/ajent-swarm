// Plain-language rendering for schedules and run timestamps. Scheduling
// semantics live server-side (POST /api/jobs/preview); this module only
// renders what a job row, a preview reply or a run row already carries.

import type { Job, ScheduleKind } from '../api/types'
import { relativeTime } from '../session/rewind'

export const intervalUnits = ['seconds', 'minutes', 'hours', 'days'] as const
export type IntervalUnit = (typeof intervalUnits)[number]

const unitSeconds: Record<IntervalUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
}

// intervalToSeconds converts the editor's value-plus-unit picker into stored
// seconds; a non-finite or negative value stays as-is for validation to flag.
export function intervalToSeconds(value: number, unit: IntervalUnit): number {
  if (!Number.isFinite(value) || value < 0) return value
  return Math.round(value * unitSeconds[unit])
}

// splitInterval picks the largest unit that divides an interval into whole
// counts, falling through to exact seconds so the server's no-floor intervals
// keep their precision through an edit round trip.
export function splitInterval(seconds?: number): { value: number; unit: IntervalUnit } {
  if (!seconds || seconds <= 0) return { value: 30, unit: 'minutes' }
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    if (seconds % unitSeconds[unit] === 0) {
      return { value: seconds / unitSeconds[unit], unit }
    }
  }
  return { value: seconds, unit: 'seconds' }
}

// formatEvery renders an interval in words: every 30 seconds, every 2 hours.
export function formatEvery(seconds?: number): string {
  const { value, unit } = splitInterval(seconds)
  if (value === 1) return `every ${unit.slice(0, -1)}` // hour, day
  return `every ${value} ${unit}`
}

// weekdayTokens are the stored day codes in canonical sun..sat order, shared
// by the editor's picker and the summary renderer.
export const weekdayTokens = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type WeekdayToken = (typeof weekdayTokens)[number]

// weekdayShort names one day each, sun..sat matching weekdayTokens.
export const weekdayShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// parseWeekdays reads a stored comma list onto tokens, unknown entries drop.
export function parseWeekdays(raw: string | undefined): WeekdayToken[] {
  if (!raw) return []
  const set = new Set(
    raw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => (weekdayTokens as readonly string[]).includes(t)),
  )
  return weekdayTokens.filter((t) => set.has(t))
}

// formatWeekdays renders chosen days in canonical order, e.g. Mon, Wed, Fri.
function formatWeekdays(raw: string | undefined): string {
  const tokens = parseWeekdays(raw)
  if (tokens.length === 0 || tokens.length === 7) return ''
  return tokens.map((t) => weekdayShort[weekdayTokens.indexOf(t)]).join(', ')
}

// scheduleSummary renders one job's cadence in plain language: every
// 30 minutes, daily at 09:00 (Europe/Berlin), once at Fri, Nov 7, 14:00.
export function scheduleSummary(
  job: Pick<
    Job,
    'scheduleKind' | 'intervalSeconds' | 'dailyTime' | 'tz' | 'weekdays' | 'nextRunAt'
  >,
): string {
  const on = formatWeekdays(job.weekdays)
  const days = on !== '' ? ` on ${on}` : ''
  switch (job.scheduleKind) {
    case 'interval':
      return formatEvery(job.intervalSeconds) + days
    case 'daily': {
      const zone = job.tz ? ` (${job.tz})` : ''
      return `daily at ${job.dailyTime || '--:--'}${zone}${days}`
    }
    case 'once':
      return `once at ${formatSlot(job.nextRunAt)}`
    default:
      return String(job.scheduleKind) // additive kinds render as-is
  }
}

// renderWhen renders one ISO moment in the viewer's zone, or a job's own when
// its zone rides along; unreadable values pass through untouched.
function renderWhen(
  iso: string | null | undefined,
  fallback: string,
  opts: Intl.DateTimeFormatOptions,
): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, opts)
}

// formatSlot renders one fire time for a human scanning a schedule: weekday,
// short date and clock time. A daily job's zone is passed through so its
// preview reads the wall clock the job itself schedules in.
export function formatSlot(iso: string | null | undefined, tz?: string): string {
  const rendered = renderWhen(iso, 'unscheduled', {
    timeZone: tz || undefined,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return tz ? `${rendered} ${tz}` : rendered
}

// formatTimestamp renders a run's start or end moment with its zone
// abbreviation riding along, so "Nov 5, 07:19 AM MST" names the zone the clock
// reads in. A job-owned tz overrides the viewer's zone like formatSlot.
export function formatTimestamp(iso: string | undefined, tz?: string): string {
  return renderWhen(iso, '—', {
    timeZone: tz || undefined,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

// relativeTimestamp renders a run's start as a recency label sharing the
// rewind picker's dialect, so ages never drift between surfaces; unreadable
// stamps render the em dash.
export function relativeTimestamp(iso: string | undefined, now: number = Date.now()): string {
  const label = relativeTime(Date.parse(iso ?? ''), now)
  return label === '' ? '—' : label
}

// formatDuration renders a run's wall-clock span as e.g. 2m 14s; unfinished
// runs report elapsed time so far.
export function formatDuration(startedAt: string, finishedAt?: string): string {
  const start = new Date(startedAt).getTime()
  if (Number.isNaN(start)) return '—'
  const endRaw = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  const end = Number.isNaN(endRaw) ? start : endRaw
  let secs = Math.max(0, Math.round((end - start) / 1000))
  const suffix = finishedAt ? '' : '…'
  if (secs < 60) return `${secs}s${suffix}`
  const hours = Math.floor(secs / 3600)
  secs %= 3600
  const mins = Math.floor(secs / 60)
  secs %= 60
  if (hours > 0) return `${hours}h ${mins}m${suffix}`
  return mins > 0 ? `${mins}m ${secs}s${suffix}` : `${secs}s${suffix}`
}

// sortJobsForDisplay orders the jobs table for scanning: enabled rows with a
// parseable next fire come first, soonest first, ties by id; everything else
// keeps its stored order after them. Pure: never mutates the caller's array,
// whose order also feeds pending-toggle holds.
export function sortJobsForDisplay(jobs: Job[]): Job[] {
  const scheduled: Array<{ at: number; job: Job }> = []
  const rest: Job[] = []
  for (const job of jobs) {
    // disabled or null/unparseable rows have nothing to sort by
    const at = job.enabled && job.nextRunAt ? new Date(job.nextRunAt).getTime() : NaN
    if (Number.isNaN(at)) rest.push(job)
    else scheduled.push({ at, job })
  }
  scheduled.sort((a, b) => a.at - b.at || a.job.id - b.job.id)
  return [...scheduled.map(({ job }) => job), ...rest]
}

// scheduleKindLabels names the editor's mode chooser entries.
export const scheduleKindLabels: Record<ScheduleKind, string> = {
  once: 'One-shot',
  interval: 'Every interval',
  daily: 'Daily at a time',
}

// runStatusClass maps a run row's status onto its badge tint; unknown statuses
// render neutral, additions being additive.
export function runStatusClass(status: string): string {
  switch (status) {
    case 'ok':
      return 'badge ok'
    case 'failed':
    case 'timeout':
      return 'badge danger'
    case 'awaiting_input':
      return 'badge warn'
    case 'running':
      return 'badge accent'
    default:
      return 'badge'
  }
}
