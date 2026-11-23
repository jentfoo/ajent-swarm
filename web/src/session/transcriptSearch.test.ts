import { describe, expect, it } from 'vitest'

import { deriveBlocks } from '../state/derive'
import type { DerivedBlock } from '../state/derive'
import type { DiffView } from '../state/eventApplier'
import { entry, messageEntry } from '../state/testFixtures'
import {
  buildSearchIndex,
  matchBlocks,
  nearestFrom,
  nearestFromAnchor,
  sameMatch,
} from './transcriptSearch'

// The find machinery stays pure here, tested apart from DOM virtualization.

// idx anchors diffs under their block the way the view's memo does.
function idx(blocks: readonly DerivedBlock[], diffs: readonly DiffView[] = []) {
  const anchored = new Map<string, DiffView[]>()
  for (const d of diffs) {
    const list = anchored.get(d.afterId)
    if (list === undefined) anchored.set(d.afterId, [d])
    else list.push(d)
  }
  return buildSearchIndex(blocks, anchored)
}

const textsOf = (blocks: readonly DerivedBlock[]) =>
  idx(blocks).flatMap((b) => b.regions.map((r) => r.text))

describe('search extraction', () => {
  it('extracts the visible text of every block kind', () => {
    const blocks: DerivedBlock[] = [
      { kind: 'user', id: 'u1', text: 'fix the bug', images: [] },
      { kind: 'chained', id: 'c1', body: 'parent tail', truncated: false, prompt: 'child prompt' },
      {
        kind: 'injected',
        id: 'i1',
        replayed: true,
        shellRun: false,
        label: 'Plan',
        body: 'step one',
      },
      {
        kind: 'assistant',
        id: 'a1',
        thinking: ['private musing'],
        parts: [
          { kind: 'text', text: 'all done' },
          { kind: 'call', call: { id: 'call_1', name: 'Bash', input: { cmd: 'go test' } } },
        ],
      },
      {
        kind: 'tool-results',
        id: 't1',
        results: [{ callId: 'call_1', toolName: 'Bash', text: 'PASS', images: [], isError: false }],
      },
      { kind: 'compaction', id: 'k1' },
      { kind: 'notice', id: 'n1', level: 'warn', text: 'heads up' },
      { kind: 'unknown', id: 'x1', type: 'brand_new' },
    ]
    expect(textsOf(blocks)).toEqual([
      'fix the bug',
      'child prompt',
      'parent tail',
      'Plan\nstep one',
      'private musing',
      'all done',
      'Bash\n{\n  "cmd": "go test"\n}',
      'PASS',
      'context compacted',
      'heads up',
      '[brand_new]',
    ])
    const labels = idx(blocks).flatMap((b) => b.regions.map((r) => r.label))
    expect(labels).toEqual([
      'user',
      'chained prompt',
      'parent response',
      'context',
      'thinking',
      'assistant',
      'tool Bash',
      'tool Bash',
      'compaction',
      'warn notice',
      'unknown',
    ])
  })

  it('extracts edit calls as their painted op texts', () => {
    const blocks: DerivedBlock[] = [
      {
        kind: 'assistant',
        id: 'a1',
        thinking: [],
        parts: [
          {
            kind: 'call',
            call: {
              id: 'call_1',
              name: 'edit',
              input: { path: 'main.go', edits: [{ oldText: 'alpha', newText: 'beta' }] },
            },
          },
        ],
      },
    ]
    expect(textsOf(blocks)).toContain('edit\nmain.go\nalpha\nbeta')
  })

  it('prefers a failed result fault like the card paints', () => {
    const blocks: DerivedBlock[] = [
      {
        kind: 'tool-results',
        id: 't1',
        results: [
          { callId: 'c1', text: 'boom', images: [], isError: true, fault: 'boom: panic here' },
        ],
      },
    ]
    expect(textsOf(blocks)).toEqual(['boom: panic here'])
  })

  it('extracts system labels from the derivation', () => {
    const blocks = deriveBlocks(
      ['01M', '01S'],
      new Map([
        ['01M', entry('01M', undefined, 'model_change', { model: 'gpt' })],
        ['01S', entry('01S', '01M', 'session_name', { name: 'swarm run' })],
      ]),
    )
    expect(textsOf(blocks)).toEqual(['model changed to gpt', 'renamed to swarm run'])
  })

  it('indexes anchored diffs and skips trailing ones', () => {
    const blocks: DerivedBlock[] = [{ kind: 'user', id: 'u1', text: 'prompt', images: [] }]
    const anchored: DiffView = { path: 'a.go', before: 'old', after: 'new', afterId: 'u1' }
    const trailing: DiffView = { path: 'b.go', before: 'x', after: 'y', afterId: '' }
    const index = idx(blocks, [anchored, trailing])
    expect(index).toHaveLength(1)
    expect(index[0].regions.at(-1)).toMatchObject({ label: 'diff', text: 'a.go\nold\nnew' })

    // a diff hit lands on the row the card rides
    expect(matchBlocks(index, 'a.go')[0]).toMatchObject({ blockId: 'u1', label: 'diff' })
    expect(matchBlocks(index, 'b.go')).toEqual([])
  })
})

describe('matching', () => {
  const blocks: DerivedBlock[] = [
    { kind: 'user', id: 'u1', text: 'test the tester', images: [] },
    { kind: 'user', id: 'u2', text: 'test again', images: [] },
  ]

  it('matches case-insensitively with distinct per-block positions', () => {
    const matches = matchBlocks(idx(blocks), 'TeSt')
    expect(matches).toHaveLength(3)
    expect(matches[0]).toMatchObject({ blockId: 'u1', at: 0 })
    expect(matches[1]).toMatchObject({ blockId: 'u1', at: 9 })
    expect(matches[2]).toMatchObject({ blockId: 'u2', at: 0 })
  })

  it('answers blank queries and misses with no matches', () => {
    expect(matchBlocks(idx(blocks), '')).toEqual([])
    expect(matchBlocks(idx(blocks), '   ')).toEqual([])
    expect(matchBlocks(idx(blocks), 'zzz')).toEqual([])
  })

  it('marks the hit inside a flattened one-line snippet', () => {
    const text = `head\n${'x'.repeat(60)}\nneedle\n${'y'.repeat(60)}`
    const blocks: DerivedBlock[] = [{ kind: 'user', id: 'u1', text, images: [] }]
    const [m] = matchBlocks(idx(blocks), 'needle')
    expect(m.snippet.startsWith('…')).toBe(true)
    expect(m.snippet.endsWith('…')).toBe(true)
    expect(m.snippet).not.toContain('\n')
    expect(m.snippet.slice(m.markAt, m.markEnd)).toBe('needle')
  })
})

describe('selection helpers', () => {
  const blocks: DerivedBlock[] = [
    { kind: 'user', id: 'u1', text: 'alpha', images: [] },
    { kind: 'user', id: 'u2', text: 'alpha alpha', images: [] },
    { kind: 'user', id: 'u3', text: 'alpha', images: [] },
  ]
  const matches = matchBlocks(idx(blocks), 'alpha')

  it('nearestFromAnchor takes the first hit at or after the anchor row', () => {
    expect(matches[nearestFromAnchor(matches, 0)]).toMatchObject({ blockId: 'u1' })
    expect(matches[nearestFromAnchor(matches, 1)]).toMatchObject({ blockId: 'u2' })
    // nothing at or after the reading position folds to the latest result
    expect(matches[nearestFromAnchor(matches, 4)]).toMatchObject({ blockId: 'u3' })
  })

  it('nearestFrom picks the survivor at or after a vanished hit', () => {
    expect(matches[nearestFrom(matches, matches[0], 0)]).toMatchObject({ blockId: 'u1' })
    expect(matches[nearestFrom(matches, matches[0], 2)]).toMatchObject({ blockId: 'u3' })
    expect(matches[nearestFrom(matches, matches[3], 2)]).toMatchObject({ blockId: 'u3' })
  })

  it('sameMatch compares coordinates', () => {
    expect(sameMatch(matches[0], matches[0])).toBe(true)
    expect(sameMatch(matches[0], matches[1])).toBe(false)
    expect(sameMatch(matches[0], matches[3])).toBe(false)
  })
})

describe('buildSearchIndex ordering', () => {
  it('numbers rows by block position so scrolls target rows', () => {
    const entries = [
      messageEntry('e1', undefined, 'user', 'needle one'),
      messageEntry('e2', 'e1', 'assistant', 'needle two'),
    ]
    const blocks = deriveBlocks(['e1', 'e2'], new Map(entries.map((e) => [e.id, e])))
    const index = idx(blocks)
    expect(index.map((b) => [b.id, b.blockIdx])).toEqual([
      ['e1', 0],
      ['e2', 1],
    ])
    const hits = matchBlocks(index, 'needle')
    expect(hits.map((m) => m.blockIdx)).toEqual([0, 1])
  })
})
