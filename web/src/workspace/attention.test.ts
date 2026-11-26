import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AttentionRow } from '../api/types'
import {
  ackBodyFor,
  anchorChained,
  attendBadgePath,
  chainNoticeOf,
  compareAttention,
  deriveItem,
  describeStop,
  failedChainOf,
  headerBadgeOf,
  noticeDwellMs,
  noticeEligible,
  rankAttention,
  resetQueueEntries,
  sessionBadgeOf,
  submitTurnEnd,
  urgencyRank,
} from './attention'
import type { AttentionItem, AttentionSort } from './attention'

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

  it('ranks chained sessions into working below the session they wait behind', () => {
    vi.useFakeTimers()
    const chained = (sessionId: string, parent: string) =>
      deriveItem(row({ sessionId, chainedOn: parent, chainedOnId: 'chn_1' }))

    vi.setSystemTime(1000)
    const ranked = rankAttention([
      deriveItem(row({ sessionId: 'busy-parent', running: true, idle: false, kind: 'working' })),
      chained('queued-child', 'busy-parent'),
      chained('late-child', 'busy-parent'),
      deriveItem(row({ sessionId: 'other-worker', running: true, idle: false, kind: 'working' })),
      chained('orphan-child', 'gone-parent'),
    ])

    // the whole chain lands in Working, each link directly below the session
    // it waits behind, and a chain whose parent is absent keeps its ranked
    // spot (the tail keeps the session-id tiebreak of the ranked order)
    expect(ranked.working.map((i) => i.sessionId)).toEqual([
      'busy-parent',
      'late-child',
      'queued-child',
      'orphan-child',
      'other-worker',
    ])
    expect(ranked.waiting).toEqual([])
    vi.useRealTimers()
  })

  it('anchors deep chains below their parent through every hop', () => {
    const anchored = anchorChained([
      { sessionId: 'c', chainedOn: 'b' },
      { sessionId: 'a' },
      { sessionId: 'b', chainedOn: 'a' },
    ])
    expect(anchored.map((r) => r.sessionId)).toEqual(['a', 'b', 'c'])

    // a parent in another queue never drags the child across sections
    const mixed = anchorChained([
      { sessionId: 'child', chainedOn: 'needs-parent' },
      { sessionId: 'free' },
    ])
    expect(mixed.map((r) => r.sessionId)).toEqual(['child', 'free'])
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

  it('marks queued while a parked prompt waits out its idle window', () => {
    const queued = deriveItem(
      row({
        sessionId: 'sb',
        kind: 'working',
        reason: 'queued: run the tests',
        parked: 1,
        parkedAt: 20,
        since: 20,
      }),
    )
    expect(queued.parked).toBe(true)
    expect(sessionBadgeOf(false, queued)).toBe('queued')
    expect(headerBadgeOf(false, queued)).toBe('queued')

    // a parked prompt behind a live turn still badges queued: the queue
    // outlives the turn, the row stays in Working through the kind
    expect(sessionBadgeOf(true, queued)).toBe('queued')
    expect(headerBadgeOf(true, queued)).toBe('queued')
  })

  it('splits waiting from idle for the switcher and folds them for headers', () => {
    const awaiting = deriveItem(row({ sessionId: 'sb' }))
    expect(awaiting.kind).toBe('awaiting')
    expect(sessionBadgeOf(false, awaiting)).toBe('waiting')
    expect(headerBadgeOf(false, awaiting)).toBe('idle')

    // a completed unreviewed turn badges review on both surfaces, the rail's
    // kind badge; the header keeps it visible like queued
    const review = deriveItem(
      row({ sessionId: 'sb', kind: 'needs-review', since: 10, lastTurnEnd: 10 }),
    )
    expect(review.kind).toBe('needs-review')
    expect(sessionBadgeOf(false, review)).toBe('review')
    expect(headerBadgeOf(false, review)).toBe('review')

    // a locally busy snapshot leads a stale digest still naming review
    expect(sessionBadgeOf(true, review)).toBe('running')

    // no digest at all reads the same as a resting session
    expect(sessionBadgeOf(false, undefined)).toBe('idle')
    expect(headerBadgeOf(false, undefined)).toBe('idle')
  })

  it('marks chained ahead of waiting and maps the digest chain fields', () => {
    const child = deriveItem(
      row({
        sessionId: '01C',
        kind: 'awaiting',
        reason: 'waiting for a prompt',
        chainedOnId: 'chn_1',
        chainedOn: '01P',
      }),
    )
    expect(child.chainedOn).toBe('01P')
    expect(child.chainedOnId).toBe('chn_1')
    expect(child.reason).toBe('waiting for a prompt') // chain facts never touch it
    expect(sessionBadgeOf(false, child)).toBe('chained')
    expect(headerBadgeOf(false, child)).toBe('chained')

    // a chained session behind a live turn or a dialog keeps that badge: the
    // chain stays visible through the fields instead
    expect(sessionBadgeOf(true, child)).toBe('running')

    const parent = deriveItem(
      row({
        sessionId: '01P',
        kind: 'awaiting',
        deliveringId: 'chn_1',
        deliveringTo: '01C',
      }),
    )
    expect(parent.deliveringTo).toBe('01C')
    expect(parent.deliveringId).toBe('chn_1')
    expect(sessionBadgeOf(false, parent)).toBe('chained')
  })

  it('names the chain role for the rail and switcher lines', () => {
    const namer = (id: string) => (id === '01P' ? 'parent' : 'child')
    const child = deriveItem(row({ sessionId: '01C', chainedOn: '01P', chainedOnId: 'chn_1' }))
    expect(chainNoticeOf(child, namer)).toBe('queued behind parent')

    const parent = deriveItem(row({ sessionId: '01P', deliveringTo: '01C', deliveringId: 'chn_1' }))
    expect(chainNoticeOf(parent, namer)).toBe('handing off to child')

    // the failure leads its own line: the live role never masks the loss
    const failed = deriveItem(
      row({
        sessionId: '01C',
        chainedOn: '01P',
        chainedOnId: 'chn_1',
        chainFailure: 'child exited',
      }),
    )
    expect(chainNoticeOf(failed, namer)).toBe('chain failed: child exited')
    expect(sessionBadgeOf(false, failed)).toBe('failed')
    expect(headerBadgeOf(false, failed)).toBe('failed')

    expect(chainNoticeOf(deriveItem(row({ sessionId: '01X' })), namer)).toBeUndefined()
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

describe('urgencyRank', () => {
  it('orders dialogs, reviews, working and waiting ahead of ended rows', () => {
    const rows: [string, number][] = [
      ['ended', urgencyRank(true, { kind: 'needs-input' })],
      ['waiting', urgencyRank(false, { kind: 'awaiting' })],
      ['digestless', urgencyRank(false)],
      ['working', urgencyRank(false, { kind: 'working' })],
      ['review', urgencyRank(false, { kind: 'needs-review' })],
      ['dialog', urgencyRank(false, { kind: 'needs-input' })],
    ]
    expect(rows.sort((a, b) => a[1] - b[1]).map(([name]) => name)).toEqual([
      'dialog',
      'review',
      'working',
      'waiting',
      'digestless', // a row the digest has not reached waits too
      'ended',
    ])
  })
})

describe('attendBadgePath', () => {
  it('opens the first dialog of the caller ranked order', () => {
    const needs = [
      deriveItem(
        row({ sessionId: 'old-review', kind: 'needs-review', since: 10, lastTurnEnd: 10 }),
      ),
      deriveItem(
        row({
          sessionId: 'a-dialog',
          openInteractions: 1,
          kind: 'needs-input',
          dialogId: 1,
          since: 20,
        }),
      ),
      deriveItem(
        row({
          sessionId: 'b-dialog',
          openInteractions: 1,
          kind: 'needs-input',
          dialogId: 2,
          since: 30,
        }),
      ),
    ]

    // an older review ranks first but never wins the badge destination
    expect(attendBadgePath(needs)).toBe('/s/a-dialog')
  })

  it('encodes the session id for the route', () => {
    const needs = [
      deriveItem(row({ sessionId: 'one two', openInteractions: 1, kind: 'needs-input' })),
    ]
    expect(attendBadgePath(needs)).toBe('/s/one%20two')
  })

  it('stays undefined without dialogs so callers keep their destination', () => {
    const needs = [deriveItem(row({ sessionId: 'sr', kind: 'needs-review', lastTurnEnd: 10 }))]
    expect(attendBadgePath(needs)).toBeUndefined()
    expect(attendBadgePath([])).toBeUndefined()
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

describe('notice dwell', () => {
  it('gates needs-input raises by age', () => {
    vi.useFakeTimers()
    vi.setSystemTime(60_000)

    const young = deriveItem(row({ sessionId: 'nd', kind: 'needs-input', since: 59_000 }))
    expect(noticeEligible(young)).toBe(false)

    const old = deriveItem(
      row({ sessionId: 'nd', kind: 'needs-input', since: 60_000 - noticeDwellMs }),
    )
    expect(noticeEligible(old)).toBe(true)
  })

  it('passes other kinds and unstamped rows', () => {
    vi.useFakeTimers()
    vi.setSystemTime(60_000)

    // review rows never raise the title or tray, so the gate ignores them
    expect(noticeEligible(deriveItem(row({ sessionId: 'nr', kind: 'needs-review' })))).toBe(true)
    // an unstamped dialog reads as aged in, the server always stamps one
    expect(noticeEligible(deriveItem(row({ sessionId: 'nu', kind: 'needs-input' })))).toBe(true)
  })
})

describe('submit-path turn acks', () => {
  it('stamps the digest row server turn end over the local clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(9_000) // a client clock far past the server's turn end

    const review = deriveItem(
      row({ sessionId: 'st', kind: 'needs-review', since: 500, lastTurnEnd: 500 }),
    )
    expect(submitTurnEnd(review)).toBe(500)

    // no digest row, or one without a review target, keeps the local clock
    expect(submitTurnEnd(undefined)).toBe(9_000)
    expect(submitTurnEnd(deriveItem(row({ sessionId: 'st' })))).toBe(9_000)
    expect(
      submitTurnEnd(deriveItem(row({ sessionId: 'st', running: true, kind: 'working' }))),
    ).toBe(9_000)
  })
})

describe('failedChainOf', () => {
  const item = (over: Partial<AttentionItem>): AttentionItem => ({
    sessionId: '01C',
    kind: 'awaiting',
    reason: '',
    since: 0,
    pid: 1,
    running: false,
    parked: false,
    ...over,
  })

  it('reads the child row failure into both endpoint ids', () => {
    const failed = failedChainOf(
      item({
        chainedOnId: 'chn_1',
        chainedOn: '01P',
        chainFailure: 'parent exited',
      }),
    )
    expect(failed).toEqual({
      chainId: 'chn_1',
      childId: '01C',
      parentId: '01P',
      reason: 'parent exited',
    })
  })

  it('reads the parent row failure, an exited child still announces', () => {
    const failed = failedChainOf(
      item({
        sessionId: '01P',
        deliveringId: 'chn_1',
        deliveringTo: '01C',
        chainFailure: 'child exited',
      }),
    )
    expect(failed).toEqual({
      chainId: 'chn_1',
      childId: '01C',
      parentId: '01P',
      reason: 'child exited',
    })
  })

  it('ignores live waits and id-less rows', () => {
    expect(failedChainOf(item({ chainedOnId: 'chn_1', chainedOn: '01P' }))).toBeUndefined()
    expect(failedChainOf(item({ chainFailure: 'parent exited' }))).toBeUndefined()
  })
})
