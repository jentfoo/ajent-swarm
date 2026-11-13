import { describe, expect, it } from 'vitest'

import {
  currentMatch,
  matchOffset,
  matchSpans,
  openSearch,
  searchKey,
  withItems,
} from './historySearch'
import type { HistorySearch, SearchKey, SearchOutcome } from './historySearch'

// The pure Ctrl+R machine, table-driven like upstream's search_test.go: the
// overlay opens blank, narrows case-insensitively, steps older on the
// repeated press, and accepts or closes on Enter and the first Esc.

// withQuery folds typed input keys so a case can start from a narrowed state.
function withQuery(items: string[], query: string): HistorySearch {
  let s = openSearch(items)
  for (const ch of query) s = searchKey(s, { type: 'input', text: ch }).search
  return s
}

describe('searchKey', () => {
  const items = ['Fix the RETRY loop', 'retry the shipping step', 'ship v2']

  it('table of key outcomes', () => {
    const cases: {
      name: string
      from: HistorySearch
      key: SearchKey
      outcome: SearchOutcome
      query?: string
      cursor?: number
      matches?: string[]
    }[] = [
      {
        name: 'typing stays open and narrows',
        from: openSearch(items),
        key: { type: 'input', text: 'retry' },
        outcome: 'stay',
        query: 'retry',
        cursor: 0,
        matches: [items[0], items[1]],
      },
      {
        name: 'filtered input keeps the query empty',
        from: openSearch(items),
        key: { type: 'input', text: '\n' },
        outcome: 'stay',
        query: '',
        cursor: 0,
        matches: [],
      },
      {
        name: 'backspace trims one character',
        from: withQuery(items, 'retry!'),
        key: { type: 'backspace' },
        outcome: 'stay',
        query: 'retry',
        cursor: 0,
        matches: [items[0], items[1]],
      },
      {
        name: 'backspace on empty query is a noop',
        from: openSearch(items),
        key: { type: 'backspace' },
        outcome: 'stay',
        query: '',
        cursor: 0,
        matches: [],
      },
      {
        name: 'step older moves to the next match',
        from: withQuery(items, 'ship'),
        key: { type: 'step-older' },
        outcome: 'stay',
        cursor: 1,
      },
      {
        name: 'step older with no matches stays put',
        from: openSearch(items),
        key: { type: 'step-older' },
        outcome: 'stay',
        cursor: 0,
        matches: [],
      },
      {
        name: 'highlight clamps to the newest',
        from: withQuery(items, 'retry'),
        key: { type: 'highlight', delta: -1 },
        outcome: 'stay',
        cursor: 0,
      },
      {
        name: 'highlight clamps to the oldest',
        from: withQuery(items, 'retry'),
        key: { type: 'highlight', delta: 1 },
        outcome: 'stay',
        cursor: 1,
      },
      {
        name: 'accept with a match',
        from: withQuery(items, 'retry'),
        key: { type: 'accept' },
        outcome: 'accept',
      },
      {
        name: 'accept without a match closes',
        from: openSearch(items),
        key: { type: 'accept' },
        outcome: 'close',
      },
      {
        name: 'explicit close',
        from: withQuery(items, 'retry'),
        key: { type: 'close' },
        outcome: 'close',
      },
    ]
    for (const tc of cases) {
      const { search, outcome } = searchKey(tc.from, tc.key)
      expect(outcome, tc.name).toBe(tc.outcome)
      if (tc.query !== undefined) expect(search.query, tc.name).toBe(tc.query)
      if (tc.cursor !== undefined) expect(search.cursor, tc.name).toBe(tc.cursor)
      if (tc.matches !== undefined) expect(search.matches, tc.name).toEqual(tc.matches)
    }
  })

  it('stepping past the oldest wraps to the newest', () => {
    const s = withQuery(items, 'ship') // two matches, cursor at the newest
    let search = searchKey(s, { type: 'step-older' }).search
    expect(search.cursor).toBe(1)
    search = searchKey(search, { type: 'step-older' }).search
    expect(search.cursor).toBe(0)
    expect(currentMatch(search)).toBe(items[1])
  })

  it('every query change restarts at the newest hit', () => {
    const stepped = searchKey(withQuery(items, 'ship'), { type: 'step-older' }).search
    expect(stepped.cursor).toBe(1)
    const narrowed = searchKey(stepped, { type: 'input', text: 'p' }).search
    expect(narrowed.cursor).toBe(0)
    expect(narrowed.matches).toEqual([items[1]])
  })

  it('pasted input drops newlines and control characters', () => {
    const { search } = searchKey(openSearch(items), {
      type: 'input',
      text: 're\rt\nry\u0000',
    })
    expect(search.query).toBe('retry')
    expect(search.matches).toEqual([items[0], items[1]])
  })

  it('backspace trims a whole code point, not a surrogate unit', () => {
    const { search } = searchKey(withQuery(items, '𝕏'), { type: 'backspace' })
    expect(search.query).toBe('')
    expect(search.matches).toEqual([])
  })

  it('currentMatch follows the cursor and reads undefined when blank', () => {
    expect(currentMatch(openSearch(items))).toBeUndefined()
    expect(currentMatch(withQuery(items, 'retry'))).toBe(items[0])
    expect(currentMatch(searchKey(withQuery(items, 'retry'), { type: 'step-older' }).search)).toBe(
      items[1],
    )
  })
})

describe('withItems', () => {
  it('refilters the current query over the fresh list', () => {
    const open = withQuery(['fix the loop'], 'loop')
    const next = withItems(open, ['fix the loop', 'loop the fix'])
    expect(next.items).toEqual(['fix the loop', 'loop the fix'])
    expect(next.query).toBe('loop')
    expect(next.matches).toEqual(['fix the loop', 'loop the fix'])
    expect(next.cursor).toBe(0) // restarts at the newest hit
  })

  it('keeps the query when nothing new matches', () => {
    const open = withQuery(['fix the loop'], 'loop')
    const next = withItems(open, ['ship v2'])
    expect(next.query).toBe('loop')
    expect(next.matches).toEqual([])
  })
})

describe('matchSpans', () => {
  it('table of span answers', () => {
    const cases: { name: string; text: string; query: string; want: [number, number][] }[] = [
      { name: 'empty query spans none', text: 'abc', query: '', want: [] },
      {
        name: 'case insensitive match',
        text: 'Fix the RETRY loop',
        query: 'retry',
        want: [[8, 13]],
      },
      {
        name: 'every occurrence non overlapping',
        text: 'aaa',
        query: 'aa',
        want: [[0, 2]],
      },
      { name: 'no match spans none', text: 'abc', query: 'zz', want: [] },
      { name: 'shifted lowering spans none', text: 'İstanbul trip', query: 'i', want: [] },
    ]
    for (const tc of cases) {
      expect(matchSpans(tc.text, tc.query), tc.name).toEqual(tc.want)
    }
  })

  it('matchOffset falls back to -1', () => {
    expect(matchOffset('Fix the RETRY loop', 'retry')).toBe(8)
    expect(matchOffset('abc', '')).toBe(-1)
    expect(matchOffset('İstanbul trip', 'i')).toBe(-1)
  })
})
