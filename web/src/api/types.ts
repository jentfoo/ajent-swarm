// Wire shapes the swarm REST surface serves, mirroring ajent's pkg/ctl
// structs and the fleet listing rows field for field.

export interface SessionInfo {
  id: string
  name?: string
}

export interface Caps {
  reasoning: boolean
  images: boolean
  parallelToolCalls: boolean
}

export interface ModelState {
  key: string
  short: string
  window: number
  caps: Caps
}

export interface ToolState {
  name: string
  source: string
  enabled: boolean
  readOnly: boolean
}

export interface UsageData {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export interface UsageState {
  turns: number
  total: UsageData
  child: UsageData
  byModel?: Record<string, UsageData>
  estimatedTurns: number
}

export interface ContextData {
  used: number
  window: number
  reserve: number
  compact: number
  estimated: boolean
}

export interface QueueRow {
  id: string
  text: string // empty for secret rows; the id always travels
}

export interface ActivityRow {
  key: string
  text: string
  rank: number
}

export interface Segment {
  key: string
  text: string
  short?: string
  order: number
}

export interface SeatState {
  held: boolean
  holder?: string
  yours: boolean
}

export interface InteractionPending {
  id: number
  kind: string // display hint only; answer shapes come from the flags
  prompt: string
  subject?: string
  options?: string[]
  multi?: boolean
  text?: boolean
  secret?: boolean
  chat?: boolean
}

// CtlState is one state.get snapshot, the same shape a stream init carries.
export interface CtlState {
  session: SessionInfo
  workspace: string
  cwd: string
  head: string
  model: ModelState
  permission: string // mode name, '' when no gate exists
  tools?: ToolState[]
  usage: UsageState
  context: ContextData
  running: boolean
  idle: boolean
  spinning: boolean
  queued: number
  queuedRows?: QueueRow[]
  activity?: ActivityRow[]
  status?: { segments?: Segment[] }
  seat: SeatState
  interactions?: InteractionPending[]
  // Snapshot stamp, present on GET /snapshot replies only (init frames omit
  // it): the actor watermark this state was read under, so events at or below
  // it are already covered by these fields.
  seq?: number
}

// Entry is one transcript line. Data stays opaque here; renderers decode the
// per-type payloads they know and ignore the rest.
export interface Entry {
  id: string
  parentId?: string
  type: string
  ts: number // unix milliseconds
  data?: unknown
}

// --- stream frames, mirroring pkg/fleet/wire.go ---

export interface InitFrame {
  type: 'init'
  sessionId: string
  state: CtlState
  entries: Entry[]
  cursor?: string // id of the oldest entry included, empty when history starts there
}

export interface WireEvent {
  event: string
  seq: number
  data?: unknown
}

export interface EventFrame {
  type: 'event'
  sessionId: string
  event: WireEvent
}

// Child states ride child frames and the listing: lifecycle facts only swarm
// knows, never announced by ajent itself.
export const ChildState = {
  Online: 'online',
  Reconnecting: 'reconnecting',
  Exited: 'exited',
  Gone: 'gone',
} as const

// childEnded reports whether a child state means the session no longer
// serves. Gone covers a run the service itself no longer sees at all.
export function childEnded(state: string): boolean {
  return state === ChildState.Exited || state === ChildState.Gone
}

export interface ChildFrame {
  type: 'child'
  sessionId: string
  state: (typeof ChildState)[keyof typeof ChildState]
  detail?: string
}

export interface ErrorFrame {
  type: 'error'
  sessionId?: string // absent for frame-level refusals that name no session
  code: string
  message?: string
}

export interface HeartbeatFrame {
  type: 'heartbeat'
}

export type ServerFrame = InitFrame | EventFrame | ChildFrame | ErrorFrame | HeartbeatFrame

// --- REST payload shapes ---

// SessionStatus is one row of GET /api/sessions.
export interface SessionStatus {
  sessionId: string
  name?: string
  title?: string // stored swarm display title, preferred for labels
  workspace?: string
  model?: string
  pid?: number
  state: (typeof ChildState)[keyof typeof ChildState]
  detail?: string
  seatHeld: boolean
  seatHolder?: string
  seatOurs: boolean
  running: boolean
  idle: boolean
  openInteractions: number
  lastTurnEnd?: number // unix milliseconds
  lastStop?: string // stop reason of the last finished turn
  lastStopErr?: string // transport or context failure that ended it
  exitedAt?: number // unix milliseconds, ended sessions
  spawnedBy: 'swarm' | 'external'
  argv?: string
  logPath?: string
  exitCode?: number | null
  logTail?: string
}

// AttentionRow is one live session's row of GET /api/attention. The digest
// facts (dialog, last stop, activity) carry the focus rail's one-line reasons.
export interface AttentionRow {
  sessionId: string
  pid?: number
  openInteractions: number
  running: boolean
  spinning?: boolean
  idle: boolean
  lastTurnEnd?: number // unix milliseconds
  dialogId?: number // oldest open dialog
  dialogPrompt?: string // its prompt, one line
  dialogAt?: number // when swarm first saw it, unix milliseconds
  lastStop?: string // stop reason of the last turn
  lastStopErr?: string
  activity?: string // top activity row, one line
}

// EntriesPage is one page of committed history plus the cursor to continue.
export interface EntriesPage {
  entries: Entry[]
  cursor?: string
}

// MeReply is GET /api/me for an authenticated principal.
export interface MeReply {
  username: string
  via: string
  home?: string // service host's home dir, for ~-relative workspace labels
}

// --- session command payloads, mirroring pkg/api/handlers_sessions.go ---

export interface SubmitReply {
  pendingId: string // the echoed correlation optimistic rows resolve by
}

export interface ModeReply {
  mode?: string // empty when no gate exists
}

export interface RewindReply {
  head: string
}

// ResolveAnswer carries exactly one answer shape, validated upstream.
export interface ResolveAnswer {
  dialogId: number
  index?: number
  indexes?: number[]
  text?: string
  chat?: boolean
  cancel?: boolean
}

export interface ResolveReply {
  settled: boolean // a first answer had already won; benign everywhere
}

// RecallRow names the queued prompt that left for edit-and-resubmit.
export interface RecallRow {
  id?: string
  text?: string
}

// ModelRow is one session's model facts from GET /api/models; switching goes
// through POST /model against the same registry models.get lists.
export interface ModelRow {
  sessionId: string
  current: ModelState
}

export type RewindKind = 'user' | 'assistant' | 'compaction'

// RewindCandidate is one rewirable entry of the transcript tree, every fork
// included; anything upstream refuses never lists here. Depth and Guide draw
// the context tree; Active marks the current head's path; Text carries a user
// prompt in full for rewind-and-edit prefill.
export interface RewindCandidate {
  id: string
  parentId?: string
  kind: RewindKind
  ts: number // unix milliseconds
  label?: string
  isHead: boolean
  depth?: number
  guide?: string
  active?: boolean
  text?: string
  truncated?: boolean
}

export interface RewindCandidates {
  head: string
  candidates: RewindCandidate[]
}

// AttachmentReply names where an upload landed for @-reference submits.
export interface AttachmentReply {
  path: string
}

// FileSuggestion is one @-completion candidate from GET /files: the replacement
// fragment for the composer token, directories carrying their trailing slash.
export interface FileSuggestion {
  path: string
  dir?: boolean
}

export interface FilesReply {
  items: FileSuggestion[]
}

// SavedSession is one row of the resume picker listing, most recently used
// first; target is what a launch passes back for the row.
export interface SavedSession {
  id: string
  name?: string
  target: string
  workspace?: string
  model?: string
  startedMs?: number
  updatedMs: number
  messages: number
  first?: string
  blocked: boolean // recorded in a newer format; resume would refuse it
  live: boolean // tracked by the fleet right now
}

export type LaunchMode = 'new' | 'resume' | 'continue' | 'session'

// --- scheduler shapes, mirroring pkg/store/jobs.go ---

export type ScheduleKind = 'once' | 'interval' | 'daily'
export type MissPolicy = 'skip' | 'fire_late'
export type OverlapPolicy = 'run' | 'skip_if_running'
export type TriggerOn = 'success' | 'error'
export type RunStatus = 'running' | 'awaiting_input' | 'ok' | 'failed' | 'timeout' | 'skipped'

// Job is one scheduled job row from /api/jobs. nextRunAt stays null while the
// job is disabled or has nothing left to fire.
export interface Job {
  id: number
  name: string
  workspace: string
  commandPrefix?: string
  prompt?: string
  spawnMode: LaunchMode
  sessionTarget?: string
  model?: string
  permission?: string
  tools?: string // comma list of enabled tool names; custom sets only
  toolsCustom?: boolean // off keeps the launched session's default set
  enabled: boolean
  scheduleKind: ScheduleKind
  intervalSeconds?: number
  dailyTime?: string // HH:MM wall clock in tz
  tz?: string // IANA name; absent means server local
  weekdays?: string // comma list of sun..sat; absent means every day
  nextRunAt?: string | null
  onMissed: MissPolicy
  overlap: OverlapPolicy
  timeoutMinutes?: number // zero means the service default applies
  keepAlive: boolean
  runWhenIdle?: boolean // hold fires until the fleet has been quiet
  idleMaxDelaySeconds?: number // past this wait a held fire skips; zero waits forever
  triggerCommand?: string // shell gate evaluated before each launch
  triggerOn?: TriggerOn // which exit outcome lets the job run
  createdAt: string
}

// Run is one row of run history from /api/runs. sessionId stays absent until
// the launch path returned one; a skipped run never launched anything.
export interface Run {
  id: number
  jobId?: number // unlinked when its job was deleted
  sessionId?: string
  prompt?: string
  trigger: 'schedule' | 'manual'
  status: RunStatus
  startedAt: string
  finishedAt?: string
  error?: string
}

// SchedulePreview is POST /api/jobs/preview's reply: the next fires of one
// draft schedule plus what its workspace path check made of the filesystem.
export interface SchedulePreview {
  times: string[]
  workspaceError?: string
}

// SavedEntriesPage is one page of an offline transcript read, oldest first,
// with the cursor to continue back in time.
export interface SavedEntriesPage {
  sessionId: string
  head: string // the derived branch tip
  path?: string
  entries: Entry[]
  cursor?: string
}

export interface LaunchRequest {
  workspace: string
  mode?: LaunchMode
  target?: string
  model?: string
  permission?: string
  commandPrefix?: string
}

// ModelListing is GET /api/sessions/{id}/models, the models.get registry with
// its active key; a controller picks without riding a picker.
export interface ModelListing {
  active: string
  models: ModelState[]
}

// GlobalSettings is GET /api/settings, swarm's own persisted settings: the
// model the one-shot session titler runs with, empty for the default.
export interface GlobalSettings {
  titleModel: string
}

export interface ToolSetReply {
  rows: ToolState[] // full replacement after the reshape
}

// SettingRow is one /settings row: label, dotted key, resolved value with its
// source layer, and whether it can change right now.
export interface SettingRow {
  label: string
  key?: string
  value?: unknown
  source?: string // default | user | project | local | session | active
  editable: boolean
  reason?: string
}

export interface SettingsRowsReply {
  rows: SettingRow[]
}

export interface SettingSetReply {
  row: SettingRow // the row after the change, menus re-render from it
}

export interface LaunchResult {
  sessionId: string
  pid: number
  workspace: string
  logPath: string
}
