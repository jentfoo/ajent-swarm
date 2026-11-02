// The editor's draft model. Validation mirrors pkg/sched.ValidateJob so
// obvious mistakes surface before a save round trip; the server re-checks
// everything on save and its errors stay authoritative.

import type { Job, LaunchMode, MissPolicy, OverlapPolicy, ScheduleKind } from '../api/types'
import { intervalToSeconds, splitInterval } from './schedule'
import type { IntervalUnit } from './schedule'

export const maxNameLen = 200 // mirrors sched's bound
export const maxPrefixLen = 2000 // mirrors sched's bound
const maxIntervalSeconds = 366 * 24 * 3600 // one leap year of seconds

// JobDraft is the form-shaped job: every field editable as its natural input
// type, with the interval split into value and unit for the picker.
export interface JobDraft {
  name: string
  workspace: string
  scheduleKind: ScheduleKind
  onceAt: string // datetime-local input value; empty until picked
  intervalValue: number
  intervalUnit: IntervalUnit
  dailyTime: string // HH:MM wall clock in tz
  tz: string // IANA name; empty means server local
  spawnMode: LaunchMode
  sessionTarget: string
  model: string
  permission: string
  commandPrefix: string
  prompt: string
  onMissed: MissPolicy
  overlap: OverlapPolicy
  timeoutMinutes: number
  keepAlive: boolean
  enabled: boolean
}

// DraftErrors keys one message per offending field, so the form marks inputs.
export type DraftErrors = Partial<Record<string, string>>

export function defaultDraft(): JobDraft {
  return {
    name: '',
    workspace: '',
    scheduleKind: 'interval',
    onceAt: '',
    intervalValue: 30,
    intervalUnit: 'minutes',
    dailyTime: '09:00',
    tz: '',
    spawnMode: 'new',
    sessionTarget: '',
    model: '',
    permission: '',
    commandPrefix: '',
    prompt: '',
    onMissed: 'skip',
    overlap: 'run',
    timeoutMinutes: 0,
    keepAlive: false,
    enabled: true,
  }
}

// draftFromJob seeds the editor from a stored row; the interval resolves to
// the whole-count unit splitInterval picked when it was saved.
export function draftFromJob(job: Job): JobDraft {
  const interval = splitInterval(job.intervalSeconds)
  return {
    name: job.name,
    workspace: job.workspace,
    scheduleKind: job.scheduleKind,
    onceAt: toLocalInput(job.nextRunAt),
    intervalValue: interval.value,
    intervalUnit: interval.unit,
    dailyTime: job.dailyTime ?? '',
    tz: job.tz ?? '',
    spawnMode: job.spawnMode,
    sessionTarget: job.sessionTarget ?? '',
    model: job.model ?? '',
    permission: job.permission ?? '',
    commandPrefix: job.commandPrefix ?? '',
    prompt: job.prompt ?? '',
    onMissed: job.onMissed,
    overlap: job.overlap,
    timeoutMinutes: job.timeoutMinutes ?? 0,
    keepAlive: job.keepAlive,
    enabled: job.enabled,
  }
}

// toPayload builds the request body a save or preview sends. Recurring jobs
// never send nextRunAt, so an update recomputes their slot; editing rides
// createdAt along for previews to anchor interval slots exactly as the saved
// row will.
export function toPayload(draft: JobDraft, id?: number): Partial<Job> {
  const payload: Partial<Job> = {
    name: draft.name.trim(),
    workspace: draft.workspace.trim(),
    scheduleKind: draft.scheduleKind,
    spawnMode: draft.spawnMode,
    sessionTarget: draft.sessionTarget.trim(),
    model: draft.model.trim(),
    permission: draft.permission,
    commandPrefix: draft.commandPrefix,
    prompt: draft.prompt,
    enabled: draft.enabled,
    onMissed: draft.onMissed,
    overlap: draft.overlap,
    timeoutMinutes: Math.round(draft.timeoutMinutes) || 0,
    keepAlive: draft.keepAlive,
  }
  switch (draft.scheduleKind) {
    case 'once': {
      const at = localInputToDate(draft.onceAt)
      payload.nextRunAt = at ? at.toISOString() : null
      break
    }
    case 'interval':
      payload.intervalSeconds = intervalToSeconds(draft.intervalValue, draft.intervalUnit)
      break
    case 'daily':
      payload.dailyTime = draft.dailyTime.trim()
      payload.tz = draft.tz.trim()
      break
  }
  if (id !== undefined) payload.id = id
  return payload
}

// validateDraft returns one message per offending field, mirroring the
// backend's rules; an empty result means the save may proceed.
export function validateDraft(draft: JobDraft): DraftErrors {
  const errors: DraftErrors = {}

  if (draft.name.trim() === '') errors.name = 'Name is required.'
  else if (draft.name.trim().length > maxNameLen)
    errors.name = `Name must be at most ${maxNameLen} characters.`
  if (draft.workspace.trim() === '') errors.workspace = 'Workspace is required.'

  switch (draft.spawnMode) {
    case 'resume':
      if (draft.sessionTarget.trim() === '')
        errors.sessionTarget = 'Resume needs a session id or name.'
      break
    case 'session':
      if (!validSessionName(draft.sessionTarget.trim()))
        errors.sessionTarget =
          'Names use letters, digits, -, _, . and /; they cannot start with a dash.'
      break
  }

  switch (draft.scheduleKind) {
    case 'once':
      if (localInputToDate(draft.onceAt) === undefined) errors.onceAt = 'Pick the fire time.'
      break
    case 'interval': {
      const secs = intervalToSeconds(draft.intervalValue, draft.intervalUnit)
      if (!Number.isFinite(secs) || secs <= 0) errors.interval = 'Interval must be positive.'
      else if (secs > maxIntervalSeconds) errors.interval = 'Interval is too large.'
      break
    }
    case 'daily':
      if (!validDailyTime(draft.dailyTime)) errors.dailyTime = 'Use HH:MM between 00:00 and 23:59.'
      break
  }

  if (draft.timeoutMinutes < 0) errors.timeoutMinutes = 'Timeout cannot be negative.'
  if (draft.commandPrefix.length > maxPrefixLen)
    errors.commandPrefix = `Command prefix must be at most ${maxPrefixLen} characters.`
  return errors
}

// validSessionName mirrors ajent's session.ValidateName charset: letters,
// digits, dash, underscore, dot and slash; no leading dash; bounded length.
export function validSessionName(name: string): boolean {
  if (name === '' || name.length > maxNameLen || name.startsWith('-')) return false
  for (const r of name) {
    const ok =
      (r >= 'a' && r <= 'z') ||
      (r >= 'A' && r <= 'Z') ||
      (r >= '0' && r <= '9') ||
      r === '-' ||
      r === '_' ||
      r === '.' ||
      r === '/'
    if (!ok) return false
  }
  return true
}

// validDailyTime mirrors the backend's HH:MM parse, including one-digit hours.
export function validDailyTime(raw: string): boolean {
  const parts = raw.trim().split(':')
  if (parts.length !== 2) return false
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false
  }
  const hour = Number(parts[0])
  const minute = Number(parts[1])
  return hour <= 23 && minute <= 59
}

// localInputToDate parses a datetime-local value as browser-local wall time.
export function localInputToDate(value: string): Date | undefined {
  if (value === '') return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d
}

// toLocalInput renders an ISO timestamp as the datetime-local input's format
// in the viewer's own zone; a missing slot stays empty.
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
