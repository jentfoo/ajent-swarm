import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttentionRow } from '../api/types'
import {
  ackBodyFor,
  attentionKindLabels,
  compareAttention,
  deriveItem,
  describeStop,
  headerBadgeOf,
  rankAttention,
  resetQueueEntries,
  sessionBadgeOf,
} from './attention'
import type { AttentionSort } from './attention'

// row builds one digest row the way the server derives it: kind, reason and
// wait arrive ready-made, ack facts ride beside them.
function row(overrides: Partial<AttentionRow> & { sessionId: string }): AttentionRow {
  return {
    openInteractions: 0,
    running: false,
    idle: true,
    kind: 'awaiting',
    reason: 'waiting for a prompt',
    ...overrides,
  }
}

beforeEach(() => {
  resetQueueEntries()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attention derivation', () => {
  it('maps digest rows verbatim onto items', () => {
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
        kind: 'needs-input',
        reason: 'allow write?',
        since: 1_000,
      }),
    )
    expect(open).toMatchObject({
      sessionId: 's1',
      pid: 11,
      kind: 'needs-input',
      reason: 'allow write?',
      since: 1_000,
      dialogId: 3,
      turnEnd: undefined,
      running: false,
    })

    // a settled dialog leaves the digest reading awaiting, and the item keeps
    // the review target the check-off needs
    const review = deriveItem(
      row({
        sessionId: 's1',
        pid: 11,
        lastTurnEnd: 900,
        lastStop: 'end_turn',
        kind: 'needs-review',
        reason: 'turn complete',
        since: 900,
      }),
    )
    expect(review).toMatchObject({ kind: 'needs-review', turnEnd: 900, since: 900 })

    const worker = deriveItem(
      row({
        sessionId: 's1',
        running: true,
        spinning: true,
        kind: 'working',
        reason: 'reading main.go',
      }),
    )
    expect(worker.kind).toBe('working')
    expect(worker.running).toBe(true) // spinning counts as busy for badges
  })

  it('falls back for unknown stop codes', () => {
    expect(describeStop('weird_new_stop', undefined)).toBe('stopped: weird_new_stop')
    expect(describeStop(undefined, undefined)).toBe('turn finished')
  })

  it('humanizes every kind for announcements', () => {
    expect(Object.entries(attentionKindLabels)).toEqual([
      ['needs-input', 'needs input'],
      ['needs-review', 'needs review'],
      ['awaiting', 'waiting'],
      ['working', 'working'],
    ])
  })
})

describe('attention ranking', () => {
  it('merges dialogs and reviews into needs by oldest wait', () => {
    const items = [
      deriveItem(row({ sessionId: 'old-dialog', kind: 'needs-input', since: 100 })),
      deriveItem(row({ sessionId: 'new-dialog', kind: 'needs-input', since: 300 })),
      deriveItem(row({ sessionId: 'old-turn', kind: 'needs-review', since: 200 })),
      deriveItem(row({ sessionId: 'new-turn', kind: 'needs-review', since: 400 })),
      deriveItem(
        row({ sessionId: 'worker', running: true, idle: false, kind: 'working', reason: 'busy' }),
      ),
      deriveItem(row({ sessionId: 'aaa-snoozing' })),
      deriveItem(row({ sessionId: 'zzz-snoozing', reason: 'tests green' })),
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
      deriveItem(row({ sessionId, running: true, idle: false, kind: 'working', reason: 'busy' }))
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
        running: true,
        idle: false,
        kind: 'needs-input',
        reason: 'allow write?',
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
    const digestRunning = deriveItem(
      row({ sessionId: 'sb', running: true, idle: false, kind: 'working' }),
    )
    expect(sessionBadgeOf(false, digestRunning)).toBe('running')
    expect(headerBadgeOf(false, digestRunning)).toBe('running')
  })

  it('splits waiting from idle for the switcher and folds them for headers', () => {
    const awaiting = deriveItem(row({ sessionId: 'sb' }))
    expect(awaiting.kind).toBe('awaiting')
    expect(sessionBadgeOf(false, awaiting)).toBe('waiting')
    expect(headerBadgeOf(false, awaiting)).toBe('idle')

    // a completed unreviewed turn rests idle on both surfaces
    const review = deriveItem(
      row({ sessionId: 'sb', kind: 'needs-review', since: 10, lastTurnEnd: 10 }),
    )
    expect(review.kind).toBe('needs-review')
    expect(sessionBadgeOf(false, review)).toBe('idle')
    expect(headerBadgeOf(false, review)).toBe('idle')

    // no digest at all reads the same as a resting session
    expect(sessionBadgeOf(false, undefined)).toBe('idle')
    expect(headerBadgeOf(false, undefined)).toBe('idle')
  })
})

describe('shared attention ordering', () => {
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

describe('explicit check-off', () => {
  it('names the dialog or turn target the ack settles', () => {
    const dialog = deriveItem(
      row({
        sessionId: 'sc',
        pid: 3,
        openInteractions: 1,
        kind: 'needs-input',
        reason: 'allow write?',
        dialogId: 9,
      }),
    )
    expect(ackBodyFor(dialog)).toEqual({ sessionId: 'sc', pid: 3, dialogId: 9 })

    const review = deriveItem(
      row({ sessionId: 'sr', kind: 'needs-review', since: 77, lastTurnEnd: 77 }),
    )
    expect(ackBodyFor(review)).toEqual({ sessionId: 'sr', turnEnd: 77 })

    // nothing else is actionable, so nothing else acks
    expect(ackBodyFor(deriveItem(row({ sessionId: 'sw' })))).toBeUndefined()
    expect(
      ackBodyFor(deriveItem(row({ sessionId: 'sw2', running: true, kind: 'working' }))),
    ).toBeUndefined()
  })
})
