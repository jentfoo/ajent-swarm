// The one client-side attention model every surface consumes: the focus rail,
// tile tab badges, the title bar count and the desktop notification bridge.
//
// Three attention kinds rise from the digest plus this ledger:
//   - needs input: open dialogs, ranked by oldest wait
//   - needs review: an idle session after a turn end not yet acknowledged
//   - awaiting: an idle agent waiting for its next prompt (rendered in the
//     rail's Needs input section, but never badged or notified)
//
// Acknowledging happens by acting (answering the dialog, submitting a prompt)
// or an explicit check-off. The ledger persists in localStorage keyed by
// session id plus the process and the dialog or turn identifier, so reloads
// never re-raise settled items and a restarted session's dialog ids cannot
// collide with the previous run's acknowledgments.
import type { AttentionRow } from '../api/types'

export type AttentionKind = 'needs-input' | 'needs-review' | 'awaiting' | 'working'

export interface AttentionItem {
  sessionId: string
  kind: AttentionKind
  reason: string // one line: the dialog prompt or the turn's stop summary
  since: number // unix ms the state started; drives waits and ranking
  pid: number
  dialogId?: number // present on needs-input rows raised by a dialog
  turnEnd?: number // present on needs-review rows
  running: boolean
  idle: boolean
}

// --- ledger, persisted under one versioned key ---

const storageKey = 'swarm.attention.v1'

interface LedgerData {
  dialogs: Record<string, Record<string, number>> // session -> 'pid:dialog' -> acked at
  turns: Record<string, number> // session -> last acknowledged turn end
}

const maxDialogAcksPerSession = 50

function emptyLedger(): LedgerData {
  return { dialogs: {}, turns: {} }
}

function readLedger(): LedgerData {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw === null) return emptyLedger()
    const parsed = JSON.parse(raw) as Partial<LedgerData>
    return {
      dialogs: parsed.dialogs && typeof parsed.dialogs === 'object' ? parsed.dialogs : {},
      turns: parsed.turns && typeof parsed.turns === 'object' ? parsed.turns : {},
    }
  } catch {
    return emptyLedger() // corrupt storage reads as fresh
  }
}

function writeLedger(data: LedgerData): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(data))
  } catch {
    // Persisting acknowledgments is best effort.
  }
}

function dialogKey(pid: number, dialogId: number): string {
  return `${pid}:${dialogId}`
}

let ledger: LedgerData = readLedger() // one read per page load, writes keep current
const ledgerListeners = new Set<() => void>()
let ledgerVersion = 0
let storageHooked = false

// Another tab acknowledging must not re-raise rows here: the storage event
// re-reads the ledger so every open view shares one acknowledgment state.
function hookStorage(): void {
  if (storageHooked || typeof window === 'undefined') return
  storageHooked = true
  window.addEventListener('storage', (ev) => {
    if (ev.key !== null && ev.key !== storageKey) return
    ledger = readLedger()
    ledgerVersion += 1
    for (const cb of ledgerListeners) cb()
  })
}

function mutateLedger(fn: (data: LedgerData) => void): void {
  fn(ledger)
  ledgerVersion += 1
  writeLedger(ledger)
  for (const cb of ledgerListeners) cb()
}

// subscribeLedger drives useSyncExternalStore; reading is versioned so React
// re-renders only when acknowledgments change.
export function subscribeLedger(cb: () => void): () => void {
  hookStorage()
  ledgerListeners.add(cb)
  return () => ledgerListeners.delete(cb)
}

export function ledgerVersionNow(): number {
  return ledgerVersion
}

// resetLedger clears acknowledgment state; page loads re-read storage, so
// only tests need this for isolation between cases.
export function resetLedger(): void {
  ledger = emptyLedger()
  ledgerVersion += 1
}

// ackDialog records one dialog answered or checked off.
export function ackDialog(sessionId: string, pid: number, dialogId: number): void {
  if (dialogId <= 0) return
  mutateLedger((data) => {
    const perSession = (data.dialogs[sessionId] ??= {})
    perSession[dialogKey(pid, dialogId)] = Date.now()
    // Bound growth: drop the oldest acknowledgments once a session stacks up.
    const keys = Object.keys(perSession)
    if (keys.length > maxDialogAcksPerSession) {
      keys
        .sort((a, b) => (perSession[a] ?? 0) - (perSession[b] ?? 0))
        .slice(0, keys.length - maxDialogAcksPerSession)
        .forEach((k) => delete perSession[k])
    }
  })
}

// ackTurn records one turn reviewed; acting later than an older turn end
// covers it too, so the stored value only ever moves forward.
export function ackTurn(sessionId: string, turnEnd: number): void {
  if (turnEnd <= 0) return
  if ((ledger.turns[sessionId] ?? 0) >= turnEnd) return
  mutateLedger((data) => {
    data.turns[sessionId] = Math.max(data.turns[sessionId] ?? 0, turnEnd)
  })
}

export function isDialogAcked(sessionId: string, pid: number, dialogId: number): boolean {
  return ledger.dialogs[sessionId]?.[dialogKey(pid, dialogId)] !== undefined
}

export function ackedTurn(sessionId: string): number {
  return ledger.turns[sessionId] ?? 0
}

// --- derivation ---

// deriveItem folds one digest row and the ledger into the session's current
// attention: needs input beats needs review, then an idle agent is awaiting
// its next prompt, and only busy sessions are working. The digest names only
// the oldest open dialog, so a session with that one acknowledged still shows
// a generic count while further dialogs wait.
export function deriveItem(row: AttentionRow): AttentionItem {
  const pid = row.pid ?? 0
  const busy = row.running || row.spinning === true
  const base = {
    sessionId: row.sessionId,
    pid,
    running: busy,
    idle: row.idle,
  }

  const dialogOpen = row.openInteractions > 0
  if (dialogOpen) {
    const oldestAcked = isDialogAcked(row.sessionId, pid, row.dialogId ?? 0)
    const unacked = row.openInteractions - (oldestAcked ? 1 : 0)
    if (unacked > 0) {
      return {
        ...base,
        kind: 'needs-input',
        reason:
          oldestAcked || !row.dialogPrompt?.trim()
            ? `${unacked} more dialog(s) open`
            : row.dialogPrompt.trim(),
        since: row.dialogAt ?? 0,
        dialogId: row.dialogId,
      }
    }
  }

  const turnEnd = row.lastTurnEnd ?? 0
  if (!busy && turnEnd > 0 && turnEnd > ackedTurn(row.sessionId)) {
    return {
      ...base,
      kind: 'needs-review',
      reason: describeStop(row.lastStop, row.lastStopErr),
      since: turnEnd,
      turnEnd,
    }
  }

  if (!busy) {
    return {
      ...base,
      kind: 'awaiting',
      reason: row.activity?.trim() || 'waiting for a prompt',
      since: 0,
    }
  }

  return {
    ...base,
    kind: 'working',
    reason: row.activity ?? '',
    since: 0,
  }
}

// rankAttention renders the rail's two fixed sections. Needs input first:
// dialogs by oldest wait, then unreviewed completions newest first, then idle
// agents waiting for a prompt in stable name order so rows never reshuffle
// mid-flight. Working below, also name-stable.
export function rankAttention(items: readonly AttentionItem[]): {
  needs: AttentionItem[]
  awaiting: AttentionItem[]
  working: AttentionItem[]
  needsInputCount: number
} {
  const needsInput = items.filter((i) => i.kind === 'needs-input').sort((a, b) => a.since - b.since)
  const needsReview = items
    .filter((i) => i.kind === 'needs-review')
    .sort((a, b) => b.since - a.since)
  const byName = (a: AttentionItem, b: AttentionItem) => a.sessionId.localeCompare(b.sessionId)
  return {
    needs: [...needsInput, ...needsReview],
    awaiting: items.filter((i) => i.kind === 'awaiting').sort(byName),
    working: items.filter((i) => i.kind === 'working').sort(byName),
    needsInputCount: needsInput.length,
  }
}

// acknowledgeItem is the explicit check-off: acting is preferred, but a row
// can always be silenced by hand.
export function acknowledgeItem(item: AttentionItem): void {
  if (item.kind === 'needs-input' && item.dialogId !== undefined) {
    ackDialog(item.sessionId, item.pid, item.dialogId)
    return
  }
  if (item.kind === 'needs-review' && item.turnEnd !== undefined) {
    ackTurn(item.sessionId, item.turnEnd)
  }
}

// describeStop turns a turn end into the row's one-line summary.
export function describeStop(stop: string | undefined, err: string | undefined): string {
  if (err) return 'turn failed'
  switch (stop) {
    case 'end_turn':
      return 'turn complete'
    case 'max_tokens':
      return 'stopped: max tokens'
    case 'aborted':
      return 'turn interrupted'
    case 'tool_use':
    case 'incomplete':
      return 'turn paused unfinished'
    case 'error':
      return 'turn failed'
    case undefined:
    case '':
    case 'unknown':
      return 'turn finished'
    default:
      return `stopped: ${stop}`
  }
}
