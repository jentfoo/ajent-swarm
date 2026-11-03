import { describe, expect, it } from 'vitest'

import { buildSwitcherRows } from './switcher'
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

const labelFor = (s: SessionStatus) => s.title ?? s.name ?? s.workspace ?? s.sessionId

describe('buildSwitcherRows', () => {
  it('orders alive sessions by attention then label', () => {
    const rows = buildSwitcherRows(
      [
        session({ sessionId: '01-idle', idle: true }),
        session({ sessionId: '02-busy', running: true, idle: false }),
      ],
      labelFor,
      [
        { ...item('working'), sessionId: '02-busy' },
        { ...item('needs-input'), sessionId: '01-idle' },
      ],
    )
    // rows carry the digest facts: badges for dialogs only
    expect(rows.filter((r) => r.needsInput).map((r) => r.sessionId)).toEqual(['01-idle'])

    // dialogs float ahead of busy sessions regardless of label order
    expect(rows.map((r) => r.sessionId)).toEqual(['01-idle', '02-busy'])
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
    const ended = rows.filter((r) => r.status === 'ended')
    expect(ended.map((r) => r.sessionId)).toEqual(['5', '4', '3', '2'])
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
    }
  })
})
