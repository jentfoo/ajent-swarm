import { describe, expect, it } from 'vitest'

import { buildSwitcherRows, groupSwitcherRows } from './switcher'
import type { SwitcherRow } from './switcher'
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
    idle: true,
  }
}

function row(overrides: Partial<SwitcherRow> = {}): SwitcherRow {
  return {
    sessionId: '01A',
    label: 'project',
    status: 'idle',
    section: 'working',
    needsInput: false,
    reason: '',
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
    // dialogs, reviews and waiting agents share Needs input; digest-less rows
    // stay in Working beside the busy ones
    expect(rows.map((r) => r.section)).toEqual([
      'needs',
      'needs',
      'needs',
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

  it('orders needs like the rail: oldest dialog, newest review', () => {
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
    expect(rows.map((r) => r.sessionId)).toEqual(['b', 'a', 'd', 'c'])
    expect(groupSwitcherRows(rows)[0]!.rows.map((r) => r.sessionId)).toEqual(['b', 'a', 'd', 'c'])
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
    expect(rows[0]!.status).toBe('idle')
    expect(rows[2]!.status).toBe('waiting')

    // waiting rows offer no check-off; actionable ones do
    expect(rows[0]!.checkOff).toBe(true)
    expect(rows[1]!.checkOff).toBe(true)
    expect(rows[2]!.checkOff).toBe(false)
    for (const row of rows) {
      if (row.status === 'waiting') expect(row.needsInput).toBe(false)
    }
  })

  it('keeps waiting and working rows name-stable', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: '02', title: 'zebra' }),
        session({ sessionId: '01', title: 'alpha' }),
        session({ sessionId: '04', title: 'yak', running: true, idle: false }),
        session({ sessionId: '03', title: 'mango', running: true, idle: false }),
      ],
      labelFor,
      [
        { ...item('awaiting'), sessionId: '02' },
        { ...item('awaiting'), sessionId: '01' },
        { ...item('working'), sessionId: '03' },
        { ...item('working'), sessionId: '04' },
      ],
    )
    // stable order follows session id, not label or digest input order
    expect(groupSwitcherRows(rows).map((g) => g.rows.map((r) => r.sessionId))).toEqual([
      ['01', '02'],
      ['03', '04'],
    ])
  })

  it('keeps the last four exited sessions beneath the alive ones', () => {
    const exited = Array.from({ length: 6 }, (_, i) =>
      session({
        sessionId: String(i),
        state: ChildState.Exited,
        exitedAt: 1000 + i,
      }),
    )
    const rows = buildSwitcherRows([session({ sessionId: 'live' }), ...exited], labelFor)
    expect(rows[0]!.sessionId).toBe('live')
    const ended = rows.filter((r) => r.section === 'ended')
    expect(ended.map((r) => r.sessionId)).toEqual(['5', '4', '3', '2'])

    const endedGroup = groupSwitcherRows(rows).find((g) => g.section === 'ended')
    expect(endedGroup!.title).toBe('Recent')
    expect(endedGroup!.rows.map((r) => r.sessionId)).toEqual(['5', '4', '3', '2'])
  })

  it('falls back to listing facts without a digest', () => {
    const rows = buildSwitcherRows(
      [session({ sessionId: 'a', running: true, idle: false }), session({ sessionId: 'b' })],
      labelFor,
    )
    expect(rows[0]!.status).toBe('running')
    expect(rows[1]!.status).toBe('idle')
    for (const row of rows) {
      expect(row.needsInput).toBe(false)
      expect(row.checkOff).toBe(false)
      expect(row.section).toBe('working')
    }
  })
})

describe('groupSwitcherRows', () => {
  it('titles sections in desktop order and drops empty ones', () => {
    const groups = groupSwitcherRows([
      row({ sessionId: '02', section: 'working' }),
      row({ sessionId: '01', section: 'needs' }),
    ])
    expect(groups.map((g) => g.section)).toEqual(['needs', 'working'])
    expect(groups.map((g) => g.title)).toEqual(['Needs input', 'Working'])
    expect(groups.map((g) => g.rows.map((r) => r.sessionId))).toEqual([['01'], ['02']])
  })

  it('preserves incoming order without re-sorting', () => {
    const groups = groupSwitcherRows([
      row({ sessionId: '03', section: 'needs' }),
      row({ sessionId: '01', section: 'needs' }),
      row({ sessionId: '02', section: 'needs' }),
    ])
    expect(groups[0]!.rows.map((r) => r.sessionId)).toEqual(['03', '01', '02'])
  })

  it('caps a hand-built ended section at four rows', () => {
    const exited = Array.from({ length: 6 }, (_, i) =>
      row({ sessionId: String(i), status: 'ended', section: 'ended', exitedAt: i }),
    )
    const groups = groupSwitcherRows([row(), ...exited])
    expect(groups.map((g) => g.section)).toEqual(['working', 'ended'])
    expect(groups[1]!.rows).toHaveLength(4)
  })
})
