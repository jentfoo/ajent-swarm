import { describe, expect, it } from 'vitest'

import { buildSwitcherRows, groupSwitcherRows, switcherRoute } from './switcher'
import type { SwitcherRow } from './switcher'
import { rankAttention } from '../workspace/attention'
import type { AttentionItem } from '../workspace/attention'
import { ChildState, type SessionStatus } from '../api/types'

function session(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: '01A',
    state: ChildState.Online,
    seatHeld: false,
    seatOurs: false,
    running: false,
    idle: true,
    queued: 0,
    openInteractions: 0,
    spawnedBy: 'swarm',
    ...overrides,
  }
}

function item(kind: AttentionItem['kind'], since = 0): AttentionItem {
  return {
    sessionId: '01A',
    kind,
    reason: `${kind} reason`,
    since,
    pid: 1,
    running: false,
    parked: false,
  }
}

function row(overrides: Partial<SwitcherRow> = {}): SwitcherRow {
  return {
    sessionId: '01A',
    label: 'project',
    status: 'idle',
    section: 'working',
    reason: '',
    queued: 0,
    checkOff: false,
    ...overrides,
  }
}

const labelFor = (s: SessionStatus) => s.title ?? s.name ?? s.workspace ?? s.sessionId

describe('buildSwitcherRows', () => {
  it('assigns sections in the desktop rail order', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: '01-dialog' }),
        session({ sessionId: '02-review' }),
        session({ sessionId: '03-waiting' }),
        session({ sessionId: '04-working', running: true, idle: false }),
        session({ sessionId: '05-unknown' }),
        session({ sessionId: '06-ended', state: ChildState.Exited, exitedAt: 1 }),
      ],
      labelFor,
      [
        { ...item('needs-input'), sessionId: '01-dialog', since: 3 },
        { ...item('needs-review'), sessionId: '02-review', since: 9 },
        { ...item('awaiting'), sessionId: '03-waiting' },
        { ...item('working'), sessionId: '04-working' },
      ],
    )
    // every human-waiting kind shares the Needs input queue, idle agents
    // wait below it, and digest-less rows stay in Working beside the busy ones
    expect(rows.map((r) => r.section)).toEqual([
      'needs',
      'needs',
      'waiting',
      'working',
      'working',
      'ended',
    ])
    expect(rows.map((r) => r.sessionId)).toEqual([
      '01-dialog',
      '02-review',
      '03-waiting',
      '04-working',
      '05-unknown',
      '06-ended',
    ])
  })

  it('merges needs kinds into one oldest-first queue', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: 'a' }),
        session({ sessionId: 'b' }),
        session({ sessionId: 'c' }),
        session({ sessionId: 'd' }),
      ],
      labelFor,
      [
        { ...item('needs-input'), sessionId: 'a', since: 10 },
        { ...item('needs-input'), sessionId: 'b', since: 2 },
        { ...item('needs-review'), sessionId: 'c', since: 5 },
        { ...item('needs-review'), sessionId: 'd', since: 9 },
      ],
    )
    expect(rows.map((r) => r.sessionId)).toEqual(['b', 'c', 'd', 'a'])
    // dialogs and reviews share the one Needs input heading, oldest first
    const groups = groupSwitcherRows(rows)
    expect(groups.map((g) => g.title)).toEqual(['Needs input'])
    expect(groups.map((g) => g.rows.map((r) => r.sessionId))).toEqual([['b', 'c', 'd', 'a']])
  })

  it('keeps dialogs ahead of reviews and waiting rows neutral', () => {
    const rows = buildSwitcherRows(
      [session({ sessionId: '01' }), session({ sessionId: '02' }), session({ sessionId: '03' })],
      labelFor,
      [
        { ...item('awaiting'), sessionId: '01' },
        { ...item('needs-review'), sessionId: '02', since: 5 },
        { ...item('needs-input'), sessionId: '03', since: 2 },
      ],
    )
    expect(rows.map((r) => r.sessionId)).toEqual(['03', '02', '01'])
    // a dialog outranks the turn still running behind it, an unreviewed turn
    // end badges review like the desktop rail
    expect(rows[0]!.status).toBe('input')
    expect(rows[1]!.status).toBe('review')
    expect(rows[2]!.status).toBe('waiting')

    // waiting rows offer no check-off, actionable ones do
    expect(rows[0]!.checkOff).toBe(true)
    expect(rows[1]!.checkOff).toBe(true)
    expect(rows[2]!.checkOff).toBe(false)
  })

  it('keeps waiting and working rows entry-stable', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: '02', title: 'zebra' }),
        session({ sessionId: '01', title: 'alpha' }),
        session({ sessionId: '04', title: 'yak', running: true, idle: false }),
        session({ sessionId: '03', title: 'mango', running: true, idle: false }),
      ],
      labelFor,
      [
        { ...item('awaiting'), sessionId: '02', queuedAt: 20 },
        { ...item('awaiting'), sessionId: '01', queuedAt: 10 },
        { ...item('working'), sessionId: '03', queuedAt: 40 },
        { ...item('working'), sessionId: '04', queuedAt: 30 },
      ],
    )
    // entry order decides, not label or digest input order
    expect(groupSwitcherRows(rows).map((g) => g.rows.map((r) => r.sessionId))).toEqual([
      ['01', '02'],
      ['04', '03'],
    ])
  })

  it('sinks parked working rows below live ones in park order', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: 'b-queued', running: true, idle: false }),
        session({ sessionId: 'a-live', running: true, idle: false }),
        session({ sessionId: 'c-queued', running: true, idle: false }),
      ],
      labelFor,
      [
        { ...item('working'), sessionId: 'b-queued', parked: true, parkedAt: 200 },
        { ...item('working'), sessionId: 'a-live' },
        { ...item('working'), sessionId: 'c-queued', parked: true, parkedAt: 300 },
      ],
    )
    expect(rows.map((r) => r.status)).toEqual(['running', 'queued', 'queued'])
    // the queued badge rows append after the live worker, oldest park first
    expect(rows.map((r) => r.sessionId)).toEqual(['a-live', 'b-queued', 'c-queued'])
  })

  it('caps old exits beneath the alive ones', () => {
    const stale = Date.now() - 3 * 60 * 60 * 1000
    const exited = Array.from({ length: 6 }, (_, i) =>
      session({
        sessionId: String(i),
        state: ChildState.Exited,
        exitedAt: stale - i * 60_000,
      }),
    )
    const rows = buildSwitcherRows([session({ sessionId: 'live' }), ...exited], labelFor)
    expect(rows[0]!.sessionId).toBe('live')
    const ended = rows.filter((r) => r.section === 'ended')
    // newest first, cut at the pinned minimum for exits past the window
    expect(ended.map((r) => r.sessionId)).toEqual(['0', '1', '2', '3'])

    const endedGroup = groupSwitcherRows(rows).find((g) => g.section === 'ended')
    expect(endedGroup!.title).toBe('Recent')
    expect(endedGroup!.rows.map((r) => r.sessionId)).toEqual(['0', '1', '2', '3'])
  })

  it('keeps recent exits beyond the pinned minimum', () => {
    const base = Date.now()
    const exited = Array.from({ length: 6 }, (_, i) =>
      session({
        sessionId: String(i),
        state: ChildState.Exited,
        exitedAt: base - (5 - i) * 60_000, // all inside the window
      }),
    )
    const rows = buildSwitcherRows(exited, labelFor)
    const ended = rows.filter((r) => r.section === 'ended')
    expect(ended.map((r) => r.sessionId)).toEqual(['5', '4', '3', '2', '1', '0'])
  })

  it('keeps the window tail beside older minimum rows', () => {
    const stale = Date.now() - 3 * 60 * 60 * 1000
    const exited = [
      ...Array.from({ length: 5 }, (_, i) =>
        session({
          sessionId: `r${i}`,
          state: ChildState.Exited,
          exitedAt: Date.now() - (4 - i) * 60_000,
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        session({ sessionId: `o${i}`, state: ChildState.Exited, exitedAt: stale - i * 60_000 }),
      ),
    ]
    const rows = buildSwitcherRows(exited, labelFor)
    // five recent exits stay whole, the pinned minimum covers the older pair
    const ended = rows.filter((r) => r.section === 'ended')
    expect(ended.map((r) => r.sessionId)).toEqual(['r4', 'r3', 'r2', 'r1', 'r0'])
  })

  it('lists twin instances as separate rows', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: 'twin', pid: 101 }),
        session({ sessionId: 'twin', pid: 102, running: true, idle: false }),
      ],
      labelFor,
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.pid)).toEqual([101, 102])
    expect(rows.map((r) => r.status)).toEqual(['idle', 'running'])
  })

  it('matches twin instances to their own digest', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: 'twin', pid: 101 }),
        session({ sessionId: 'twin', pid: 102, running: true, idle: false }),
      ],
      labelFor,
      [
        { ...item('needs-input'), sessionId: 'twin', pid: 102, since: 7 },
        { ...item('awaiting'), sessionId: 'twin', pid: 101 },
      ],
    )
    const [first, second] = rows
    expect(first!.pid).toBe(102)
    expect(first!.section).toBe('needs')
    // the dialog parks the running turn: blocked on the human, not working
    expect(first!.status).toBe('input')
    expect(second!.pid).toBe(101)
    expect(second!.section).toBe('waiting')
    expect(second!.status).toBe('waiting')
  })

  it('falls back to listing facts without a digest', () => {
    const rows = buildSwitcherRows(
      [session({ sessionId: 'a', running: true, idle: false }), session({ sessionId: 'b' })],
      labelFor,
    )
    expect(rows[0]!.status).toBe('running')
    expect(rows[1]!.status).toBe('idle')
    for (const row of rows) {
      expect(row.checkOff).toBe(false)
      expect(row.section).toBe('working')
    }
  })

  it('ranks alive rows exactly like the desktop rail', () => {
    const attentionItems = [
      { ...item('needs-input'), sessionId: 'a-dialog', since: 30 },
      { ...item('awaiting'), sessionId: 'b-idle' },
      { ...item('working'), sessionId: 'c-busy' },
      { ...item('needs-review'), sessionId: 'd-turn', since: 50 },
      { ...item('needs-input'), sessionId: 'e-dialog', since: 10 },
      { ...item('needs-review'), sessionId: 'f-turn', since: 20 },
    ]
    const sessions = attentionItems.map((i) => session({ sessionId: i.sessionId }))
    const rows = buildSwitcherRows(sessions, labelFor, attentionItems)

    // the rows mirror the rail queues: human-waiting rows under Needs
    // input by oldest wait, idle agents under Waiting, busy rows under Working
    const ranked = rankAttention(attentionItems)
    expect(ranked.needs.map((i) => i.sessionId)).toEqual([
      'e-dialog',
      'f-turn',
      'a-dialog',
      'd-turn',
    ])
    expect(rows.map((r) => r.section)).toEqual([
      'needs',
      'needs',
      'needs',
      'needs',
      'waiting',
      'working',
    ])
    expect(rows.map((r) => r.sessionId)).toEqual(
      [...ranked.needs, ...ranked.waiting, ...ranked.working].map((i) => i.sessionId),
    )
  })

  it('moves chained rows into working below the session they wait behind', () => {
    const chained = (sessionId: string, parent: string): AttentionItem => ({
      ...item('awaiting'),
      sessionId,
      chainedOn: parent,
      chainedOnId: 'chn_1',
    })
    const attentionItems = [
      { ...item('working'), sessionId: 'parent', running: true },
      chained('child', 'parent'),
      chained('orphan', 'gone-parent'),
      { ...item('working'), sessionId: 'other', running: true },
      { ...item('awaiting'), sessionId: 'free-idle' },
    ]
    const rows = buildSwitcherRows(
      attentionItems.map((i) => session({ sessionId: i.sessionId })),
      labelFor,
      attentionItems,
    )

    // the child ranks working with the chained badge and carries its parent
    const child = rows.find((r) => r.sessionId === 'child')!
    expect(child.section).toBe('working')
    expect(child.status).toBe('chained')
    expect(child.chainedOn).toBe('parent')
    // the idle parent stays waiting, the orphan child keeps its ranked spot
    expect(rows.find((r) => r.sessionId === 'free-idle')!.section).toBe('waiting')

    // the Working group anchors the child directly below its parent; the
    // other rows keep their ranked order (all entries tie here, so the
    // session-id tiebreak places them)
    const working = groupSwitcherRows(rows).find((g) => g.section === 'working')!
    expect(working.rows.map((r) => r.sessionId)).toEqual(['orphan', 'other', 'parent', 'child'])
  })

  it('pins lead the list in pin order', () => {
    const attentionItems = [
      { ...item('needs-input'), sessionId: 'a-dialog', since: 10 },
      { ...item('awaiting'), sessionId: 'b-idle' },
      { ...item('working'), sessionId: 'c-busy', running: true },
    ]
    const rows = buildSwitcherRows(
      attentionItems.map((i) => session({ sessionId: i.sessionId })),
      labelFor,
      attentionItems,
      ['c-busy', 'a-dialog'], // pin order, not rank order
    )
    expect(rows.map((r) => r.section)).toEqual(['pinned', 'pinned', 'waiting'])
    expect(rows.map((r) => r.sessionId)).toEqual(['c-busy', 'a-dialog', 'b-idle'])

    const groups = groupSwitcherRows(rows)
    expect(groups.map((g) => g.section)).toEqual(['pinned', 'waiting'])
    expect(groups[0]!.title).toBe('Pinned')
  })

  it('unpins back into the ranked queues', () => {
    const attentionItems = [
      { ...item('needs-input'), sessionId: 'a-dialog', since: 10 },
      { ...item('working'), sessionId: 'c-busy', running: true },
    ]
    const rows = buildSwitcherRows(
      attentionItems.map((i) => session({ sessionId: i.sessionId })),
      labelFor,
      attentionItems,
      ['gone-session'], // a pin the listing no longer knows is inert
    )
    expect(rows.map((r) => r.section)).toEqual(['needs', 'working'])
  })

  it('keeps pinned ended rows in Recent', () => {
    const rows = buildSwitcherRows(
      [session({ sessionId: '01-ended', state: ChildState.Exited, exitedAt: Date.now() })],
      labelFor,
      undefined,
      ['01-ended'],
    )
    expect(rows.map((r) => r.section)).toEqual(['ended'])
  })

  it('carries the listing queue depth onto rows', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: '01-live', queued: 3 }),
        session({ sessionId: '02-ended', state: ChildState.Exited, exitedAt: 1, queued: 2 }),
      ],
      labelFor,
    )
    expect(rows.find((r) => r.sessionId === '01-live')!.queued).toBe(3)
    // waiting work cannot outlive the run
    expect(rows.find((r) => r.sessionId === '02-ended')!.queued).toBe(0)
  })
})

describe('switcherRoute', () => {
  it('routes ended rows read-only and alive rows live', () => {
    expect(switcherRoute(row({ sessionId: '01LIVE' }))).toBe('/s/01LIVE')
    expect(switcherRoute(row({ sessionId: '01ENDED', status: 'ended', section: 'ended' }))).toBe(
      '/m/read/01ENDED',
    )
  })
})

describe('groupSwitcherRows', () => {
  it('titles sections in desktop order and drops empty ones', () => {
    const groups = groupSwitcherRows([
      row({ sessionId: '01', section: 'needs' }),
      row({ sessionId: '02', section: 'needs' }),
      row({ sessionId: '03', section: 'waiting' }),
      row({ sessionId: '04', section: 'working' }),
    ])
    expect(groups.map((g) => g.section)).toEqual(['needs', 'waiting', 'working'])
    expect(groups.map((g) => g.title)).toEqual(['Needs input', 'Waiting', 'Working'])
    expect(groups.map((g) => g.rows.map((r) => r.sessionId))).toEqual([
      ['01', '02'],
      ['03'],
      ['04'],
    ])
  })

  it('preserves incoming order without re-sorting', () => {
    const groups = groupSwitcherRows([
      row({ sessionId: '03', section: 'needs' }),
      row({ sessionId: '01', section: 'needs' }),
      row({ sessionId: '02', section: 'needs' }),
    ])
    expect(groups[0]!.rows.map((r) => r.sessionId)).toEqual(['03', '01', '02'])
  })

  it('caps a stale hand-built ended section at four rows', () => {
    const stale = Date.now() - 3 * 60 * 60 * 1000
    const exited = Array.from({ length: 6 }, (_, i) =>
      row({ sessionId: String(i), status: 'ended', section: 'ended', exitedAt: stale - i }),
    )
    const groups = groupSwitcherRows([row(), ...exited])
    expect(groups.map((g) => g.section)).toEqual(['working', 'ended'])
    expect(groups[1]!.rows).toHaveLength(4)
  })
})
