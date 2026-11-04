// The editor's draft model. Validation mirrors pkg/sched.ValidateJob so
// obvious mistakes surface before a save round trip; the server re-checks
// everything on save and its errors stay authoritative.

import type {
  Job,
  LaunchMode,
  MissPolicy,
  OverlapPolicy,
  ScheduleKind,
  TriggerOn,
} from '../api/types'
import { intervalToSeconds, splitInterval, weekdayTokens } from './schedule'
import type { IntervalUnit, WeekdayToken } from './schedule'

export const maxNameLen = 200 // mirrors sched's bound
export const maxTriggerLen = 2000 // mirrors sched's bound
export const maxToolsLen = 2000 // mirrors sched's bound on the joined list
const maxIntervalSeconds = 366 * 24 * 3600 // one leap year of seconds

// Length bounds are server-side Go string lengths, so they count UTF-8 bytes.
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// byteLength reports a string's UTF-8 size, the unit the server's bounds use.
function byteLength(s: string): number {
  return textEncoder.encode(s).length
}

// Run-when-idle delay options: how long a held fire may wait before it skips.
// Zero means never skipped. The labels double as the dropdown's entries.
export const idleDelayOptions = [
  { value: 0, label: 'Never skipped' },
  { value: 600, label: '10 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 7200, label: '2 hours' },
] as const

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
  weekdays: WeekdayToken[] // chosen days; recurring jobs only, empty means every day
  spawnMode: LaunchMode
  sessionTarget: string
  model: string
  permission: string
  customTools: boolean // on replaces the launched session's default set
  tools: string[] // enabled names; only meaningful while customTools holds
  commandPrefix: string // legacy stored rows round-trip untouched; no editor owns it
  prompt: string
  onMissed: MissPolicy
  overlap: OverlapPolicy
  timeoutMinutes: number
  keepAlive: boolean
  runWhenIdle: boolean
  idleMaxDelaySeconds: number // zero waits forever
  triggerCommand: string
  triggerOn: TriggerOn
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
    weekdays: [],
    spawnMode: 'new',
    sessionTarget: '',
    model: '',
    permission: '',
    customTools: false,
    tools: [],
    commandPrefix: '',
    prompt: '',
    onMissed: 'skip',
    overlap: 'run',
    timeoutMinutes: 0,
    keepAlive: false,
    runWhenIdle: false,
    idleMaxDelaySeconds: 3600,
    triggerCommand: '',
    triggerOn: 'success',
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
    weekdays: parseWeekdays(job.weekdays),
    spawnMode: job.spawnMode,
    sessionTarget: job.sessionTarget ?? '',
    model: job.model ?? '',
    permission: job.permission ?? '',
    customTools: job.toolsCustom ?? false,
    tools: parseToolList(job.tools),
    commandPrefix: job.commandPrefix ?? '',
    prompt: job.prompt ?? '',
    onMissed: job.onMissed,
    overlap: job.overlap,
    timeoutMinutes: job.timeoutMinutes ?? 0,
    keepAlive: job.keepAlive,
    runWhenIdle: job.runWhenIdle ?? false,
    idleMaxDelaySeconds: job.idleMaxDelaySeconds ?? 3600,
    triggerCommand: job.triggerCommand ?? '',
    triggerOn: job.triggerOn ?? 'success',
    enabled: job.enabled,
  }
}

// duplicateDraft seeds a Duplicate action from a stored row: "Copy of …"
// name clipped to the server's byte bound, enabled forced off so the copy
// never fires unreviewed, and a one-shot slot cleared since it is usually
// past by duplication time. Everything else copies verbatim.
export function duplicateDraft(job: Job): JobDraft {
  const draft = draftFromJob(job)
  if (job.scheduleKind === 'once') draft.onceAt = ''
  // encodeInto stops on a code-point boundary, so the clip mirrors the
  // server's UTF-8 byte bound; lone surrogates read back as U+FFFD.
  const buf = new Uint8Array(maxNameLen)
  const { written } = textEncoder.encodeInto(`Copy of ${draft.name}`, buf)
  draft.name = textDecoder.decode(buf.subarray(0, written))
  draft.enabled = false
  return draft
}

// parseWeekdays reads the stored comma list onto tokens, ignoring anything
// unknown so a hand-edited row still opens.
function parseWeekdays(raw: string | undefined): WeekdayToken[] {
  if (!raw) return []
  const set = new Set(
    raw
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter((t) => (weekdayTokens as readonly string[]).includes(t)),
  )
  return weekdayTokens.filter((t) => set.has(t))
}

// parseToolList reads the stored comma list onto names, dropping empties and
// duplicates so a hand-edited row still opens; order follows the stored tokens.
function parseToolList(raw: string | undefined): string[] {
  if (!raw) return []
  return [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    ),
  ]
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
    toolsCustom: draft.customTools,
    // the server clears the stored list when custom is off; sending the empty
    // string keeps every client's payload describing the same row
    tools: draft.customTools ? draft.tools.join(',') : '',
    commandPrefix: draft.commandPrefix,
    prompt: draft.prompt,
    enabled: draft.enabled,
    onMissed: draft.onMissed,
    overlap: draft.overlap,
    timeoutMinutes: Math.round(draft.timeoutMinutes) || 0,
    keepAlive: draft.keepAlive,
    runWhenIdle: draft.runWhenIdle,
    idleMaxDelaySeconds: Math.max(0, Math.round(draft.idleMaxDelaySeconds)),
    triggerCommand: draft.triggerCommand,
    triggerOn: draft.triggerOn,
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
    case 'daily': {
      payload.dailyTime = draft.dailyTime.trim()
      payload.tz = draft.tz.trim()
      break
    }
  }
  // weekday restrictions apply to every recurring cadence: daily slots skip
  // unchosen days and an interval runs only on them, till canceled
  if (draft.scheduleKind !== 'once') {
    payload.weekdays = weekdayList(draft.weekdays)
  }
  if (id !== undefined) payload.id = id
  return payload
}

// weekdayList renders the chosen tokens in canonical sun..sat order.
function weekdayList(chosen: WeekdayToken[]): string {
  const set = new Set(chosen)
  return weekdayTokens.filter((t) => set.has(t)).join(',')
}

// validateDraft returns one message per offending field, mirroring the
// backend's rules; an empty result means the save may proceed.
export function validateDraft(draft: JobDraft): DraftErrors {
  const errors: DraftErrors = {}

  if (draft.name.trim() === '') errors.name = 'Name is required.'
  else if (byteLength(draft.name.trim()) > maxNameLen)
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
  if (draft.idleMaxDelaySeconds < 0) errors.idle = 'Idle delay cannot be negative.'
  // the server trims before checking, so the bound applies to the trimmed value
  if (byteLength(draft.triggerCommand.trim()) > maxTriggerLen)
    errors.triggerCommand = `Trigger command must be at most ${maxTriggerLen} characters.`
  // the joined form is what the server stores, so it bounds the same way
  if (draft.customTools && byteLength(draft.tools.join(',')) > maxToolsLen)
    errors.tools = `Tool list must be at most ${maxToolsLen} characters.`
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
