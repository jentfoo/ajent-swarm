import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttentionRow } from '../api/types'
import {
  ackDialog,
  ackTurn,
  acknowledgeItem,
  ackedTurn,
  attendBadgeLabels,
  attentionRank,
  attentionRanks,
  compareAttention,
  deriveItem,
  describeStop,
  headerBadgeOf,
  isDialogAcked,
  rankAttention,
  ledgerVersionNow,
  resetLedger,
  resetQueueEntries,
  sessionBadgeOf,
  subscribeLedger,
} from './attention'
import type { AttentionSort } from './attention'

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
  resetQueueEntries()
})

afterEach(() => {
  vi.useRealTimers()
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

  it('falls back for unknown stop codes', () => {
    expect(describeStop('weird_new_stop', undefined)).toBe('stopped: weird_new_stop')
    expect(describeStop(undefined, undefined)).toBe('turn finished')
  })
})

describe('attention ranking', () => {
  it('merges dialogs and reviews into needs by oldest wait', () => {
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
    // dialogs and completions share one oldest-first order regardless of kind
    expect(ranked.needs.map((i) => i.sessionId)).toEqual([
      'old-dialog',
      'old-turn',
      'new-dialog',
      'new-turn',
    ])
    expect(ranked.working.map((i) => i.sessionId)).toEqual(['worker'])
    // idle agents wait in their own queue, name-stable within one batch
    expect(ranked.waiting.map((i) => i.sessionId)).toEqual(['aaa-snoozing', 'zzz-snoozing'])
    expect(ranked.waiting[1].reason).toBe('tests green')
    expect(ranked.needsInputCount).toBe(2)
  })

  it('moves a row to the end of its new queue on a kind change', () => {
    vi.useFakeTimers()
    const busy = (sessionId: string) =>
      deriveItem(row({ sessionId, running: true, idle: false, activity: 'busy' }))
    const idle = (sessionId: string) => deriveItem(row({ sessionId }))

    vi.setSystemTime(1000)
    const first = rankAttention([busy('aaa-settled'), busy('zzz-mover')])
    expect(first.working.map((i) => i.sessionId)).toEqual(['aaa-settled', 'zzz-mover'])

    // the second worker goes idle later: it must land behind the settled row
    vi.setSystemTime(2000)
    const second = rankAttention([busy('aaa-settled'), idle('zzz-mover')])
    expect(second.working.map((i) => i.sessionId)).toEqual(['aaa-settled'])
    expect(second.waiting.map((i) => i.sessionId)).toEqual(['zzz-mover'])

    // a later waiting arrival still appends behind the earlier one
    vi.setSystemTime(3000)
    const third = rankAttention([idle('aaa-settled'), idle('zzz-mover')])
    expect(third.waiting.map((i) => i.sessionId)).toEqual(['zzz-mover', 'aaa-settled'])
  })
})

describe('session badge states', () => {
  it('ranks a pending dialog over a turn still running', () => {
    const parked = deriveItem(
      row({
        sessionId: 'sb',
        openInteractions: 1,
        dialogId: 2,
        running: true,
        idle: false,
      }),
    )
    expect(parked.kind).toBe('needs-input')
    expect(sessionBadgeOf(true, parked)).toBe('input')
    expect(headerBadgeOf(true, parked)).toBe('input')
  })

  it('marks working from the busy fact or the digest', () => {
    expect(sessionBadgeOf(true, undefined)).toBe('running')

    // a digest that still names the turn running keeps the badge there even
    // before the local snapshot catches up
    const digestRunning = deriveItem(row({ sessionId: 'sb', running: true, idle: false }))
    expect(sessionBadgeOf(false, digestRunning)).toBe('running')
    expect(headerBadgeOf(false, digestRunning)).toBe('running')
  })

  it('splits waiting from idle for the switcher and folds them for headers', () => {
    const awaiting = deriveItem(row({ sessionId: 'sb' }))
    expect(awaiting.kind).toBe('awaiting')
    expect(sessionBadgeOf(false, awaiting)).toBe('waiting')
    expect(headerBadgeOf(false, awaiting)).toBe('idle')

    // a completed unreviewed turn rests idle on both surfaces
    const review = deriveItem(row({ sessionId: 'sb', lastTurnEnd: 10 }))
    expect(review.kind).toBe('needs-review')
    expect(sessionBadgeOf(false, review)).toBe('idle')
    expect(headerBadgeOf(false, review)).toBe('idle')

    // no digest at all reads the same as a resting session
    expect(sessionBadgeOf(false, undefined)).toBe('idle')
    expect(headerBadgeOf(false, undefined)).toBe('idle')
  })
})

describe('shared attention ordering', () => {
  it('ranks queues in rail order, digest-less rows with working', () => {
    expect(attentionRank({ sessionId: 's', kind: 'needs-input' })).toBe(attentionRanks.needs)
    expect(attentionRank({ sessionId: 's', kind: 'needs-review' })).toBe(attentionRanks.needs)
    expect(attentionRank({ sessionId: 's', kind: 'awaiting' })).toBe(attentionRanks.waiting)
    expect(attentionRank({ sessionId: 's', kind: 'working' })).toBe(attentionRanks.working)

    // a listing row without a digest never outranks actionable ones
    expect(attentionRank({ sessionId: 's' })).toBe(attentionRanks.working)
  })

  it('sorts queues first, oldest wait inside needs, entries below', () => {
    const rows: AttentionSort[] = [
      { sessionId: 'zzz-busy', kind: 'working', queuedAt: 50 },
      { sessionId: 'new-dialog', kind: 'needs-input', since: 500 },
      { sessionId: 'b-idle', kind: 'awaiting', queuedAt: 300 },
      { sessionId: 'old-turn', kind: 'needs-review', since: 100 },
      { sessionId: 'aaa-plain' }, // digest-less ranks with working
      { sessionId: 'old-dialog', kind: 'needs-input', since: 100 },
      { sessionId: 'a-idle', kind: 'awaiting', queuedAt: 100 },
    ]
    expect([...rows].sort(compareAttention).map((r) => r.sessionId)).toEqual([
      'old-dialog', // needs merges kinds by oldest wait, names break ties
      'old-turn',
      'new-dialog',
      'a-idle', // waiting and working queue by entry, movers append
      'b-idle',
      'aaa-plain', // digest-less reads as oldest within working
      'zzz-busy',
    ])
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

describe('attend badge labels', () => {
  it('returns dom attribute spelling for the shells', () => {
    expect(attendBadgeLabels(2)).toEqual({
      title: '2 session(s) need input',
      'aria-label': '2 sessions need input',
    })
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
