// Plain-language rendering for schedules and run timestamps. Scheduling
// semantics live server-side (POST /api/jobs/preview); this module only
// renders what a job row, a preview reply or a run row already carries.

import type { Job, ScheduleKind } from '../api/types'

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

// weekdayLabels name one day each; indexed by JS Date.getDay() (sunday first).
// weekdayLabels name one day each, indexed by token position (sunday first).
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
export function formatWeekdays(raw: string | undefined): string {
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

// renderWhen renders one ISO moment in the viewer's zone, or a daily job's
// own when its zone rides along; unreadable values pass through untouched.
function renderWhen(
  iso: string | null | undefined,
  tz: string | undefined,
  fallback: string,
  withWeekday?: boolean,
): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz || undefined,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }
  if (withWeekday) opts.weekday = 'short'
  return d.toLocaleString(undefined, opts) + (tz ? ` ${tz}` : '')
}

// formatSlot renders one fire time for a human scanning a schedule: weekday,
// short date and clock time. A daily job's zone is passed through so its
// preview reads the wall clock the job itself schedules in.
export function formatSlot(iso: string | null | undefined, tz?: string): string {
  return renderWhen(iso, tz, 'unscheduled', true)
}

// formatTimestamp renders a run's start or end moment without the weekday.
export function formatTimestamp(iso: string | undefined, tz?: string): string {
  return renderWhen(iso, tz, '—')
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

// scheduleKindLabel names the editor's mode chooser entries.
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
