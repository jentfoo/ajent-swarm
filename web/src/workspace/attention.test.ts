import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttentionRow } from '../api/types'
import {
  ackDialog,
  ackTurn,
  acknowledgeItem,
  ackedTurn,
  deriveItem,
  describeStop,
  isDialogAcked,
  rankAttention,
  ledgerVersionNow,
  resetLedger,
  subscribeLedger,
} from './attention'

function row(overrides: Partial<AttentionRow> & { sessionId: string }): AttentionRow {
  return {
    openInteractions: 0,
    running: false,
    idle: true,
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
  resetLedger()
})

// dispatchStorageEvent mimics another tab writing the ledger: nothing changes
// in this document's storage, but the listener re-reads it.
function dispatchStorageEvent(): void {
  subscribeLedger(() => {}) // installs the listener
  window.dispatchEvent(new StorageEvent('storage', { key: 'swarm.attention.v1' }))
}

describe('attention derivation', () => {
  it('raises needs input from open dialogs and clears when settled', () => {
    const open = deriveItem(
      row({
        sessionId: 's1',
        pid: 11,
        openInteractions: 1,
        running: false,
        idle: true,
        dialogId: 3,
        dialogPrompt: 'allow write?',
        dialogAt: 1_000,
      }),
    )
    expect(open.kind).toBe('needs-input')
    expect(open.reason).toBe('allow write?')
    expect(open.dialogId).toBe(3)
    expect(open.since).toBe(1_000)

    // a settled dialog leaves an agent waiting for its next prompt
    const settled = deriveItem(
      row({ sessionId: 's1', pid: 11, openInteractions: 0, running: false, idle: true }),
    )
    expect(settled.kind).toBe('awaiting')
    expect(settled.reason).toBe('waiting for a prompt')
  })

  it('raises needs review after an unacknowledged turn end, not before', () => {
    const midTurn = deriveItem(
      row({ sessionId: 's2', running: true, idle: false, lastTurnEnd: 500 }),
    )
    expect(midTurn.kind).toBe('working')

    const ended = deriveItem(
      row({
        sessionId: 's2',
        running: false,
        idle: true,
        lastTurnEnd: 900,
        lastStop: 'end_turn',
      }),
    )
    expect(ended.kind).toBe('needs-review')
    expect(ended.reason).toBe('turn complete')
    expect(ended.turnEnd).toBe(900)

    // acting covers the turn: acknowledgment moves the ledger forward, and
    // the agent drops back to awaiting its next prompt
    ackTurn('s2', 900)
    expect(deriveItem(row({ sessionId: 's2', lastTurnEnd: 900 })).kind).toBe('awaiting')

    // a newer turn end raises review again
    expect(deriveItem(row({ sessionId: 's2', lastTurnEnd: 1_500 })).kind).toBe('needs-review')
  })

  it('keeps acknowledged dialogs quiet across reloads of the same run', () => {
    ackDialog('s3', 7, 42)
    const sameRun = deriveItem(
      row({
        sessionId: 's3',
        pid: 7,
        openInteractions: 1,
        dialogId: 42,
        dialogPrompt: 'still open',
      }),
    )
    expect(sameRun.kind).toBe('awaiting') // checked off stays settled, still waiting

    // a restarted process reuses dialog ids: a new pid must re-raise
    const freshRun = deriveItem(
      row({
        sessionId: 's3',
        pid: 8,
        openInteractions: 1,
        dialogId: 42,
        dialogPrompt: 'still open',
      }),
    )
    expect(freshRun.kind).toBe('needs-input')
    expect(isDialogAcked('s3', 7, 42)).toBe(true)
    expect(isDialogAcked('s3', 8, 42)).toBe(false)
  })

  it('persists the ledger across storage reloads', () => {
    ackDialog('s4', 1, 5)
    ackTurn('s4', 123)
    const stored = localStorage.getItem('swarm.attention.v1') ?? ''
    expect(stored).toContain('"1:5"') // pid:dialog keeps runs apart
    expect(stored).toContain('"s4":123')

    // another tab's acknowledgment arrives as a storage event: the ledger
    // re-reads, so a fresh mount never re-raises settled items
    dispatchStorageEvent()
    expect(ackedTurn('s4')).toBe(123)
    expect(isDialogAcked('s4', 1, 5)).toBe(true)
  })

  it('falls back to a count reason while further dialogs wait', () => {
    ackDialog('s5', 2, 1)
    const item = deriveItem(
      row({
        sessionId: 's5',
        pid: 2,
        openInteractions: 2,
        dialogId: 1,
        dialogPrompt: 'oldest',
      }),
    )
    expect(item.kind).toBe('needs-input')
    expect(item.reason).toBe('1 more dialog(s) open')
  })

  it('prefers failure summaries in stop reasons', () => {
    expect(describeStop('end_turn', undefined)).toBe('turn complete')
    expect(describeStop('max_tokens', undefined)).toBe('stopped: max tokens')
    expect(describeStop('aborted', undefined)).toBe('turn interrupted')
    expect(describeStop('error', 'boom')).toBe('turn failed')
    expect(describeStop(undefined, undefined)).toBe('turn finished')
    expect(describeStop('weird_new_stop', undefined)).toBe('stopped: weird_new_stop')
  })
})

describe('attention ranking', () => {
  it('orders dialogs by oldest wait, then reviews newest first', () => {
    const items = [
      deriveItem(row({ sessionId: 'old-dialog', openInteractions: 1, dialogId: 1, dialogAt: 100 })),
      deriveItem(row({ sessionId: 'new-dialog', openInteractions: 1, dialogId: 2, dialogAt: 300 })),
      deriveItem(row({ sessionId: 'old-turn', lastTurnEnd: 200 })),
      deriveItem(row({ sessionId: 'new-turn', lastTurnEnd: 400 })),
      deriveItem(row({ sessionId: 'worker', running: true, idle: false })),
      deriveItem(row({ sessionId: 'aaa-snoozing' })),
      deriveItem(row({ sessionId: 'zzz-snoozing', activity: 'tests green' })),
    ]
    const ranked = rankAttention(items)
    expect(ranked.needs.map((i) => i.sessionId)).toEqual([
      'old-dialog',
      'new-dialog',
      'new-turn',
      'old-turn',
    ])
    expect(ranked.working.map((i) => i.sessionId)).toEqual(['worker'])
    // agents waiting for a prompt land after the actionable rows, name-sorted
    expect(ranked.awaiting.map((i) => i.sessionId)).toEqual(['aaa-snoozing', 'zzz-snoozing'])
    expect(ranked.awaiting[1].reason).toBe('tests green')
    expect(ranked.needsInputCount).toBe(2)
  })
})

describe('attention ledger events', () => {
  it('notifies subscribers only on real changes', () => {
    const seen = vi.fn()
    const stop = subscribeLedger(seen)
    const before = ledgerVersionNow()

    ackTurn('sx', 0) // turn end 0 is never actionable
    expect(seen).not.toHaveBeenCalled()

    ackTurn('sx', 100)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(ledgerVersionNow()).toBeGreaterThan(before)

    ackTurn('sx', 50) // never moves backward
    expect(seen).toHaveBeenCalledTimes(1)

    stop()
  })
})

describe('explicit check-off', () => {
  it('acknowledges whichever item the row carries', () => {
    const dialog = deriveItem(
      row({ sessionId: 'sc', pid: 3, openInteractions: 1, dialogId: 9, dialogAt: 1 }),
    )
    acknowledgeItem(dialog)
    expect(isDialogAcked('sc', 3, 9)).toBe(true)

    const review = deriveItem(row({ sessionId: 'sr', lastTurnEnd: 77 }))
    acknowledgeItem(review)
    expect(ackedTurn('sr')).toBe(77)
  })
})
