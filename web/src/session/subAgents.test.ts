import { describe, expect, it } from 'vitest'

import {
  barActivity,
  capRows,
  cardSubAgentRow,
  formatElapsed,
  jobsLive,
  stoppableJob,
  subAgentRows,
  subAgentTally,
} from './subAgents'
import type { ActivityRow, AgentJob, Segment } from '../api/types'

// The one sub-agent agreement: rows sort by job number, both bands cap like
// upstream's four-row band, a poll card renders only the job it waits on,
// the badge counts live rows first with structured counts over the prose
// parse (the pre-12a fallback), and the status bar's plain pick leads with
// the newest row.

function row(key: string, rank: number, text = `${key}  thinking…`): ActivityRow {
  return { key, text, rank }
}

// segmentOf wraps one subagents segment, with or without structured counts.
function segmentOf(text: string, counts?: Record<string, number>): Segment[] {
  return [{ key: 'subagents', text, order: 40, counts }]
}

describe('subAgentRows', () => {
  it('sorts jobs by rank', () => {
    const rows = [row('sub-3', 3), row('step', 10), row('sub-1', 1)]
    expect(subAgentRows(rows).map((r) => r.key)).toEqual(['sub-1', 'sub-3'])
  })

  it('tolerates a missing activity family', () => {
    expect(subAgentRows(undefined)).toEqual([])
  })
})

describe('capRows', () => {
  it.each([
    ['under the cap', 3, 3, 0],
    ['at the cap', 4, 4, 0],
    ['lone hidden row listed', 5, 5, 0],
    ['two hidden by overflow', 6, 4, 2],
    ['many hidden by overflow', 9, 4, 5],
  ])('%s', (_name, total, wantRows, wantOverflow) => {
    const rows = Array.from({ length: total }, (_, i) => row(`sub-${i + 1}`, i))
    const view = capRows(rows)
    // the cap hides the tail, keeping the head visible
    expect(view.rows.map((r) => r.key)).toEqual(rows.slice(0, wantRows).map((r) => r.key))
    expect(view.overflow).toBe(wantOverflow)
  })
})

describe('barActivity', () => {
  it('leads with the newest plain row', () => {
    const view = barActivity([row('call-1', 5), row('sub-1', 0), row('call-2', 5)])
    expect(view.rows.map((r) => r.key)).toEqual(['call-2', 'call-1'])
    expect(view.overflow).toBe(0)
  })

  it('caps the oldest under the overflow line', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`call-${i + 1}`, 5))
    const view = barActivity(rows)
    expect(view.rows.map((r) => r.key)).toEqual(['call-6', 'call-5', 'call-4', 'call-3'])
    expect(view.overflow).toBe(2)
  })

  it('tolerates a missing activity family', () => {
    expect(barActivity(undefined)).toEqual({ rows: [], overflow: 0 })
  })
})

describe('cardSubAgentRow', () => {
  const rows = [row('sub-1', 0, 'sub-1  reading'), row('sub-2', 1, 'sub-2  drafting')]

  it.each([
    ['live poll names own job', { name: 'agent_poll', input: { id: 'sub-2' } }, 'sub-2'],
    ['bare poll id normalizes', { name: 'agent_poll', input: { id: '1' } }, 'sub-1'],
    [
      'double-encoded poll input',
      { name: 'agent_poll', input: JSON.stringify({ id: 'sub-1' }) },
      'sub-1',
    ],
    ['poll without id argument', { name: 'agent_poll' }, undefined],
    ['unknown poll id', { name: 'agent_poll', input: { id: 'sub-7' } }, undefined],
    ['live start card', { name: 'agent_start', input: { task: 'look around' } }, undefined],
    ['other tool card', { name: 'bash', input: { cmd: 'ls' } }, undefined],
  ])('%s', (_name, call, want) => {
    expect(cardSubAgentRow(call, rows)?.key).toBe(want)
  })

  it('hides the line once the result lands', () => {
    const settled = { name: 'agent_poll', input: { id: 'sub-2' }, result: { output: 'done' } }
    expect(cardSubAgentRow(settled, rows)).toBeUndefined()
  })

  it('hides the line on a card closed without a result', () => {
    const closed = { name: 'agent_poll', input: { id: 'sub-2' }, closed: true }
    expect(cardSubAgentRow(closed, rows)).toBeUndefined()
  })
})

describe('subAgentTally', () => {
  const segment = (text: string, counts?: Record<string, number>): Segment[] => [
    { key: 'subagents', text, order: 40, counts },
  ]

  it('counts live rows ahead of the segment', () => {
    const activity = [row('sub-3', 3), row('sub-1', 1)]
    const tally = subAgentTally(activity, segment('subagents: 5 running, 9 done'))
    expect(tally.active).toBe(2)
    expect(tally.done).toBe(9)
    // the tooltip rides the rank-sorted rows
    expect(tally.rows.map((r) => r.key)).toEqual(['sub-1', 'sub-3'])
  })

  it('prefers structured counts over the prose', () => {
    // upstream wording may drift, the counts are the contract
    const tally = subAgentTally(
      [],
      segment('subagents: unreadable prose', { running: 1, queued: 2, done: 5 }),
    )
    expect(tally.active).toBe(3)
    expect(tally.done).toBe(5)
  })

  it('fills missing count keys with zero', () => {
    const tally = subAgentTally([], segment('subagents: 2 running', { running: 2 }))
    expect(tally.active).toBe(2)
    expect(tally.done).toBe(0)
  })

  it('parses the segment without live rows', () => {
    const tally = subAgentTally([], segment('subagents: 1 running, 2 queued, 4 done'))
    expect(tally.active).toBe(3)
    expect(tally.done).toBe(4)
    expect(tally.rows).toEqual([])
  })

  it('keeps upstream wording when the tally drifts', () => {
    const tally = subAgentTally(undefined, segment('subagents: unclear'))
    expect(tally.active).toBe(0)
    expect(tally.done).toBe(0)
    expect(tally.segment?.text).toBe('subagents: unclear')
  })

  it('ignores other segments and empty text', () => {
    const tally = subAgentTally(undefined, [
      { key: 'subagents', text: '', order: 40 },
      { key: 'tokens', text: '1.2k tok', order: 0 },
    ])
    expect(tally.segment).toBeUndefined()
    expect(tally.active).toBe(0)
    expect(tally.done).toBe(0)
  })
})

describe('jobsLive', () => {
  it.each([
    ['live rows', [row('sub-1', 0)], undefined, true],
    ['running tally', undefined, segmentOf('subagents: 1 running', { running: 1 }), true],
    ['queued tally', undefined, segmentOf('subagents: 2 queued', { queued: 2 }), true],
    ['done only', undefined, segmentOf('subagents: 4 done', { done: 4 }), false],
    ['nothing at all', undefined, undefined, false],
  ])('%s', (_name, activity, segments, want) => {
    expect(jobsLive(activity, segments)).toBe(want)
  })
})

describe('stoppableJob', () => {
  const job = (status: AgentJob['status']): AgentJob => ({ id: 'sub-1', status })

  it.each([
    ['missing record still in flight', undefined, true],
    ['queued', job('queued'), true],
    ['running', job('running'), true],
    ['done', job('done'), false],
    ['error', job('error'), false],
    ['aborted', job('aborted'), false],
  ])('%s', (_name, jobOrUndefined, want) => {
    expect(stoppableJob(jobOrUndefined)).toBe(want)
  })
})

describe('formatElapsed', () => {
  it.each([
    ['sub-minute seconds', 45_000, '45s'],
    ['rounds to seconds', 45_600, '46s'],
    ['minutes', 125_000, '2m05s'],
    ['hours', 3_780_000, '1h03m'],
    ['absent reads empty', undefined, ''],
    ['negative reads empty', -5, ''],
  ])('%s', (_name, ms, want) => {
    expect(formatElapsed(ms)).toBe(want)
  })
})
