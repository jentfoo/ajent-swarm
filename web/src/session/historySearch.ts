// Pure reverse history search state machine, the web transcription of
// ajent's pkg/tui/search.go: the overlay opens blank, typing narrows on a
// case-insensitive substring, repeated Ctrl+R steps to older matches, and
// Enter or the first Esc accepts the highlighted match (with no match it
// closes instead). The overlay presentation claims the arrows, so they move
// the list highlight rather than step matches.

export interface HistorySearch {
  items: readonly string[] // full recall source, newest first, deduplicated
  query: string
  matches: string[] // substring hits, newest first
  cursor: number // index into matches
}

// What the overlay does after one key: stay open, accept the highlighted
// match into the draft, or close leaving the draft untouched.
export type SearchOutcome = 'stay' | 'accept' | 'close'

// SearchKey is a DOM keyboard event reduced to one overlay action.
export type SearchKey =
  | { type: 'input'; text: string } // printable text or a paste, appended
  | { type: 'backspace' } // trims one character
  | { type: 'replace'; query: string } // virtual keyboards edit arbitrarily
  | { type: 'step-older' } // the repeated Ctrl+R
  | { type: 'highlight'; delta: number } // the claimed arrows move the row
  | { type: 'accept' } // Enter or the first Esc
  | { type: 'close' } // the close affordance

// openSearch arms the overlay over one recall source. Nothing shows until
// text is typed: an empty query matches nothing.
export function openSearch(items: readonly string[]): HistorySearch {
  return { items, query: '', matches: [], cursor: 0 }
}

// searchKey applies one key and reports the outcome. Every answer is a new
// state object, so the machine stays pure under React replay.
export function searchKey(
  s: HistorySearch,
  key: SearchKey,
): { search: HistorySearch; outcome: SearchOutcome } {
  switch (key.type) {
    case 'input':
      return { search: refilter(s, s.query + filterQuery(key.text)), outcome: 'stay' }
    case 'replace':
      // virtual keyboards and IMEs bypass claimed keydowns entirely; their
      // whole edit arrives as one change, so restate the query verbatim
      return { search: refilter(s, filterQuery(key.query)), outcome: 'stay' }
    case 'backspace': {
      // trim one character, not one UTF-16 unit, so an astral tail survives
      const chars = Array.from(s.query)
      if (chars.length === 0) return { search: s, outcome: 'stay' }
      return { search: refilter(s, chars.slice(0, -1).join('')), outcome: 'stay' }
    }
    case 'step-older': {
      // the only stepping key; oldest folds back onto the newest
      const cursor = s.matches.length === 0 ? 0 : (s.cursor + 1) % s.matches.length
      return { search: { ...s, cursor }, outcome: 'stay' }
    }
    case 'highlight': {
      // list convention over ajent's wrap: visible rows clamp, never wrap
      const cursor = Math.max(0, Math.min(s.cursor + key.delta, s.matches.length - 1))
      return { search: { ...s, cursor }, outcome: 'stay' }
    }
    case 'accept':
      return { search: s, outcome: s.matches.length > 0 ? 'accept' : 'close' }
    case 'close':
      return { search: s, outcome: 'close' }
  }
}

// currentMatch is the highlighted candidate, undefined when nothing matches.
export function currentMatch(s: HistorySearch): string | undefined {
  return s.matches[s.cursor]
}

// withItems swaps the recall source under an open search, refiltering the
// current query over the fresh list: a workspace mirror that lands after the
// overlay opened joins the matches in progress, restarting at the newest hit
// like any query change.
export function withItems(s: HistorySearch, items: readonly string[]): HistorySearch {
  return refilter({ ...s, items }, s.query)
}

// refilter recomputes the match set on a case-insensitive substring, newest
// first as the source arrived. Every query change restarts at the newest hit.
function refilter(s: HistorySearch, query: string): HistorySearch {
  const q = query.toLowerCase()
  const matches = q === '' ? [] : s.items.filter((it) => it.toLowerCase().includes(q))
  return { ...s, query, matches, cursor: 0 }
}

// filterQuery keeps the query one line of plain text: newlines and control
// characters never join it, matching ajent's filterInput.
function filterQuery(text: string): string {
  return Array.from(text)
    .filter((ch) => ch >= ' ' && ch !== '\u007f')
    .join('')
}

// matchSpans finds every case-insensitive occurrence of query in text as
// non-overlapping [start, end) pairs. A lowering that shifts offsets yields
// no spans at all, the same degradation upstream's highlight takes.
export function matchSpans(text: string, query: string): [number, number][] {
  const q = query.toLowerCase()
  if (q === '') return []
  const lower = text.toLowerCase()
  if (lower.length !== text.length) return []
  const spans: [number, number][] = []
  let at = 0
  for (;;) {
    const hit = lower.indexOf(q, at)
    if (hit === -1) break
    spans.push([hit, hit + q.length])
    at = hit + q.length
  }
  return spans
}

// matchOffset is the first match's start for caret placement, -1 when it
// cannot be located: callers park the caret at the end instead.
export function matchOffset(text: string, query: string): number {
  return matchSpans(text, query)[0]?.[0] ?? -1
}
