import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { EntryBlock } from './EntryBlock'
import { FindBar } from './FindBar'
import { LiveStreamBlock } from './LiveStreamBlock'
import { DiffCard } from './DiffCard'
import { MarkdownBlock } from './MarkdownBlock'
import type { AgentJobs } from './useAgentJobs'
import type { AppliedSessionState, DiffView } from '../state/eventApplier'
import type { LoadOlderResult } from '../stream/sessionStore'
import { deriveBlocks } from '../state/derive'
import {
  buildSearchIndex,
  matchBlocks,
  nearestFrom,
  nearestFromAnchor,
  sameMatch,
} from './transcriptSearch'
import type { TranscriptMatch } from './transcriptSearch'

// Bottom gap still counting as "at the latest row", scrolling above it
// disengages autoscroll and shows the jump pill.
const stickGap = 60

// pullDownPx is how far a downward drag may rubber-band at the very top of the
// history before the mobile pull-to-latest gesture fires.
const pullDownPx = 64

// How long after a user scroll input a scroll event still counts as theirs.
const userScrollWindowMs = 250

// Keys whose press means "scroll away from the latest row".
const scrollAwayKeys = new Set(['ArrowUp', 'PageUp', 'Home'])

// TranscriptView renders the committed chain as a virtualized block list keyed
// by entry id, with each anchored diff riding its block's row, unanchored ones
// trailing beneath, and the pinned live stream at the bottom. Stick-to-bottom
// autoscroll disengages only on a user scroll up, a pill jumps back to the
// latest, relabeling `↓ New output` when transcript content arrived while the
// view sat unstuck. The session-local Find surface scrolls committed rows into
// view and marks the active hit's row. A sessionId change (swapping sessions
// inside one hosted view) re-lands on the latest too and resets both.
export function TranscriptView({
  sessionId,
  state,
  loadOlder,
  pullDownToLatest = false, // mobile: rubber-band at the top jumps to latest
  onThinkingToggle,
  agentJobs,
}: {
  sessionId: string
  state: AppliedSessionState
  loadOlder: () => Promise<LoadOlderResult>
  pullDownToLatest?: boolean
  // Threaded to the live thinking panel so user toggles reach the applier.
  onThinkingToggle: (open: boolean) => void
  // The sub-agent pull listing feeding the chips band and poll cards.
  agentJobs?: AgentJobs
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stuckRef = useRef(true)
  const anchorRef = useRef<string | null>(null) // block id kept in view across a prepend
  const lastTopRef = useRef(0) // previous scrollTop, for the direction check
  const userScrollAtRef = useRef(-Infinity) // last user scroll input, perf.now()
  const gutterDragRef = useRef(false) // pointer held down on the scrollbar
  const lastTouchYRef = useRef<number | null>(null) // touch drag direction
  const [showPill, setShowPill] = useState(false)
  // Why the last load-older attempt failed, a retry that answers clears it.
  const [loadError, setLoadError] = useState('')
  // unread marks transcript content that arrived while the view sat unstuck.
  // It rides the applier's content revision, so snapshots, older-history
  // prepends and measurement churn can never raise it; sticking back clears.
  const [unread, setUnread] = useState(false)
  const revRef = useRef(state.contentRev)

  const setStuck = useCallback((stuck: boolean) => {
    stuckRef.current = stuck
    setShowPill(!stuck)
    if (stuck) setUnread(false) // back at the tail, nothing stays unread
  }, [])

  // Calls still painting live hide their committed twins until a carrier's
  // results fold and the buffer retires them: one card per call, not two.
  // Identity rides membership, not the tools array the applier swaps per event.
  const hideLiveToolIds = useHiddenToolIds(state.live)

  // Permit verdicts keyed by call id keep approval chips on committed cards
  // after the live buffer retires them. A verdict always attaches to a call
  // still painting live, so it joins only when that card retires.
  const verdicts = useVerdictChips(state.permitVerdicts, hideLiveToolIds)

  // Derivation re-runs only when the chain object, the hidden call membership
  // or a readable verdict moves: streamed tool deltas change none, so settled
  // history renders once through a whole chatty turn. The entries map mutates
  // in place with a stable identity, which is why the chain is the trigger.
  const blocks = useMemo(
    () => deriveBlocks(state.chain.ids, state.entries, hideLiveToolIds, verdicts),
    [state.chain, state.entries, hideLiveToolIds, verdicts],
  )

  // Diffs anchor to the block they arrived after, a card sits inside its row
  // wrapper so the virtualizer measures them together. Trailing holds the
  // pre-history case ('' anchor) plus anchors with no visible block, never
  // rewound-away history: the applier prunes those on branch changes.
  const { diffsByAnchor, trailingDiffs } = useMemo(() => {
    const visible = new Set(blocks.map((b) => b.id))
    const byAnchor = new Map<string, DiffView[]>()
    const trailing: DiffView[] = []
    for (const d of state.diffs) {
      if (!visible.has(d.afterId)) {
        trailing.push(d)
        continue
      }
      const anchored = byAnchor.get(d.afterId)
      if (anchored === undefined) byAnchor.set(d.afterId, [d])
      else anchored.push(d)
    }
    return { diffsByAnchor: byAnchor, trailingDiffs: trailing }
  }, [blocks, state.diffs])

  // TanStack Virtual returns unstable function values by design, the compiler
  // opt-out is documented upstream and safe with our row keys.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => blocks[i].id,
  })

  // --- transcript find ---

  // findQuery holds the open find surface's query, null while closed. Opening
  // never moves the reading position and closing preserves it.
  const [findQuery, setFindQuery] = useState<string | null>(null)
  const [activeMatch, setActiveMatch] = useState<TranscriptMatch | null>(null)
  // The find index exists only while find is open: extraction walks the whole
  // transcript, so settled streaming turns never pay for it.
  const index = useMemo(
    () => (findQuery === null ? [] : buildSearchIndex(blocks, diffsByAnchor)),
    [blocks, diffsByAnchor, findQuery],
  )
  const matches = useMemo(
    () => (findQuery === null ? [] : matchBlocks(index, findQuery)),
    [index, findQuery],
  )
  const activeIdx = activeMatch === null ? -1 : matches.findIndex((m) => sameMatch(m, activeMatch))

  // Keeps the selection honest without moving the reader: a query change
  // (open, type, close) resets deterministically to the match nearest the
  // reading position, and reconciliation keeps the active match or its
  // nearest survivor so live updates only ever refresh the count. Render-time
  // adjustment, the useHiddenToolIds pattern, so selection never lags input.
  const lastQueryRef = useRef<string | null>(null)
  if (findQuery !== lastQueryRef.current) {
    lastQueryRef.current = findQuery
    if (findQuery === null || matches.length === 0) {
      if (activeMatch !== null) setActiveMatch(null)
    } else {
      const anchor = virtualizer.getVirtualItems()[0]?.index ?? 0
      setActiveMatch(matches[nearestFromAnchor(matches, anchor)])
    }
  } else if (findQuery !== null && matches.length > 0 && activeIdx === -1) {
    // the active match vanished through reconciliation, or matches refilled
    // under a held query: the nearest survivor keeps the count truthful
    const refIdx = activeMatch === null ? -1 : blocks.findIndex((b) => b.id === activeMatch.blockId)
    setActiveMatch(matches[nearestFrom(matches, activeMatch ?? { region: 0, at: -1 }, refIdx)])
  }

  // lastFindScroll dedupes the scroll a stable match would repeat: stepping
  // between hits in one row retargets nothing, and reconciliation that keeps
  // the same hit never moves the reader.
  const lastFindScrollRef = useRef('')
  useEffect(() => {
    if (activeIdx < 0) return
    const match = matches[activeIdx]
    const key = `${lastQueryRef.current}\n${match.blockId}`
    if (key === lastFindScrollRef.current) return
    lastFindScrollRef.current = key
    const idx = blocks.findIndex((b) => b.id === match.blockId)
    if (idx < 0) return
    // navigating off the tail disengages autoscroll; onScroll re-sticks when
    // a target lands back at the bottom
    setStuck(false)
    virtualizer.scrollToIndex(idx, { align: 'center' })
  }, [activeIdx, matches, blocks, virtualizer, setStuck])

  const stepFind = useCallback(
    (delta: 1 | -1) => {
      if (findQuery === null || matches.length === 0) return
      setActiveMatch((prev) => {
        const at = prev === null ? -1 : matches.findIndex((m) => sameMatch(m, prev))
        return matches[at < 0 ? 0 : (at + delta + matches.length) % matches.length]
      })
    },
    [findQuery, matches],
  )

  const closeFind = useCallback(() => {
    setFindQuery(null)
    lastFindScrollRef.current = '' // reopening rescrolls its first target
  }, [])

  // One ResizeObserver over the content wrapper and the scroller keeps
  // autoscroll honest through dynamic row measurement, live text growth and
  // late image loads. Watching the scroller matters on phones: each keyboard
  // inset step shrinks it mid-animation, so a stuck view re-pins instead of
  // stranding the tail behind the composer or wherever WebKit's focus
  // reveal pass left it.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      if (stuckRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    ro.observe(el)
    el.scrollTop = el.scrollHeight // land on the latest history, not the top
    return () => ro.disconnect()
  }, [])

  // Only a genuine user scroll disengages autoscroll: the virtualizer's
  // measurement corrections (and this view's own re-pins) also write scrollTop,
  // and a correction can land below the pinned tail mid-burst, which reads as
  // an upward scroll no user made. Wheel-up, a downward finger drag, the
  // scroll-away keys and a classic scrollbar drag mark the scroll events that
  // follow as user-driven. Overlay scrollbar drags (WebKit) fire nothing the
  // page can see, wheel and keys still cover those readers.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const arm = () => {
      userScrollAtRef.current = performance.now()
    }
    const onWheel = (ev: WheelEvent) => {
      if (ev.deltaY < 0) arm()
    }
    const onTouchStart = (ev: TouchEvent) => {
      lastTouchYRef.current = ev.touches[0]?.clientY ?? null
    }
    const onTouchMove = (ev: TouchEvent) => {
      const y = ev.touches[0]?.clientY
      if (y === undefined) return
      if (lastTouchYRef.current !== null && y > lastTouchYRef.current) arm()
      lastTouchYRef.current = y
    }
    const onKey = (ev: KeyboardEvent) => {
      if (scrollAwayKeys.has(ev.key)) arm()
    }
    const onPointerDown = (ev: PointerEvent) => {
      // a scrollbar drag never wheels: classic gutters hit-test into the
      // element, overlay ones are 0 wide and stay uncovered here
      const gutter = el.offsetWidth - el.clientWidth
      if (gutter <= 0) return
      const rect = el.getBoundingClientRect()
      if (ev.clientX < rect.right - gutter) return
      gutterDragRef.current = true
      arm()
    }
    const onPointerUp = () => {
      gutterDragRef.current = false
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKey)
    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // scroll events while the thumb is held keep the drag's intent fresh
    if (gutterDragRef.current) userScrollAtRef.current = performance.now()
    const userScrolled = performance.now() - userScrollAtRef.current < userScrollWindowMs
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < stickGap
    if (atBottom) {
      setStuck(true)
    } else if (userScrolled && el.scrollTop < lastTopRef.current) {
      setStuck(false)
    }
    lastTopRef.current = el.scrollTop
  }, [setStuck])

  // Loading older history prepends rows, anchor the previously-first block so
  // the view does not jump, and disengage autoscroll while reading. A dry or
  // failed page drops the anchor instead of letting it fire later.
  const loadOlderAnchored = useCallback(async () => {
    anchorRef.current = blocks[0]?.id ?? null
    setStuck(false)
    const result = await loadOlder()
    if (result.kind !== 'loaded') {
      // no page is landing, a failure paints its reason until a retry answers
      anchorRef.current = null
      setLoadError(result.kind === 'failed' ? result.message : '')
      return
    }
    setLoadError('')
  }, [blocks, loadOlder, setStuck])

  useEffect(() => {
    if (anchorRef.current === null) return
    const id = anchorRef.current
    anchorRef.current = null
    // Block indexes are what the virtualizer scrolls by, chain positions skip
    // entries that derive to no block.
    const idx = blocks.findIndex((b) => b.id === id)
    if (idx > 0) virtualizer.scrollToIndex(idx, { align: 'start' })
  }, [blocks, virtualizer])

  const jumpToLatest = useCallback(() => {
    setStuck(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight // the observer settles measurement
  }, [setStuck])

  // A hosted view swaps sessions in place, the new session's transcript
  // always opens on its latest, never wherever the previous one sat. Local
  // control state resets with it, so no old failure reason, find surface or
  // unread mark carries over.
  const lastSessionRef = useRef(sessionId)
  useEffect(() => {
    if (lastSessionRef.current === sessionId) return
    lastSessionRef.current = sessionId
    revRef.current = state.contentRev // the new session re-bases the revision
    setLoadError('')
    closeFind()
    jumpToLatest()
  }, [sessionId, state.contentRev, jumpToLatest, closeFind])

  // Declared after the swap effect, so the re-base lands before this compare
  // and a hosted session swap can never read as new output.
  useEffect(() => {
    if (state.contentRev === revRef.current) return
    revRef.current = state.contentRev
    if (!stuckRef.current) setUnread(true)
  }, [state.contentRev])

  // Pull-to-latest: while already at the top of history, dragging further down
  // is dead overscroll, exactly where a gesture cannot fight scrolling. The
  // drag distance rides touchmove so it works through the rubber band. A touch
  // that scrolled first stays void for its whole life and only one finger
  // qualifies, mirroring usePullToRefresh.
  useEffect(() => {
    if (!pullDownToLatest) return
    const el = scrollRef.current
    if (!el) return
    let startY: number | null = null
    let scrolled = false // the page moved under the finger; voids the candidate
    const begin = (ev: TouchEvent) => {
      // one fresh finger seeds a candidate, anything else kills it
      startY = ev.touches.length === 1 ? ev.touches[0].clientY : null
      scrolled = false
    }
    const move = (ev: TouchEvent) => {
      if (startY === null || ev.touches.length !== 1) return
      // first scrolled move voids the candidate: returning to the top mid-touch
      // never resumes from the original start (mirrored by usePullToRefresh)
      if (el.scrollTop > 0) scrolled = true
      if (scrolled) return
      const dy = ev.touches[0].clientY - startY
      if (dy >= pullDownPx) {
        startY = null
        jumpToLatest()
      }
    }
    // lift or cancel drops any candidate
    const stop = () => {
      startY = null
      scrolled = false
    }
    el.addEventListener('touchstart', begin, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', stop, { passive: true })
    el.addEventListener('touchcancel', stop, { passive: true })
    return () => {
      el.removeEventListener('touchstart', begin)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', stop)
      el.removeEventListener('touchcancel', stop)
    }
  }, [pullDownToLatest, jumpToLatest])

  return (
    <div className="transcript-wrap" aria-label="Transcript">
      {!state.chain.rooted && state.chain.ids.length > 0 && (
        <>
          <p>
            <button type="button" className="load-older" onClick={() => void loadOlderAnchored()}>
              Load older history
            </button>
          </p>
          {loadError !== '' && <p className="error-text">{loadError}</p>}
        </>
      )}
      <div ref={scrollRef} className="transcript-scroll" onScroll={onScroll}>
        <div ref={contentRef}>
          {blocks.length > 0 && (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const block = blocks[item.index]
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className={
                      activeIdx >= 0 && matches[activeIdx].blockId === block.id
                        ? 'find-target'
                        : undefined
                    }
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <EntryBlock block={block} />
                    {diffsByAnchor.get(block.id)?.map((d, i) => (
                      <DiffCard
                        key={`${i}-${d.path}`}
                        path={d.path}
                        before={d.before}
                        after={d.after}
                      />
                    ))}
                  </div>
                )
              })}
            </div>
          )}
          {trailingDiffs.map((d, i) => (
            <DiffCard key={`${i}-${d.path}`} path={d.path} before={d.before} after={d.after} />
          ))}
          {state.prints.map((p) => (
            <div key={p.id} className="entry print-card card">
              <span className="block-role">printed</span>
              <MarkdownBlock text={p.markdown} />
            </div>
          ))}
          {state.live && (
            <LiveStreamBlock
              live={state.live}
              activity={state.snapshot.activity}
              agentJobs={agentJobs}
              // an open dialog gates the live tail: queued calls wait behind it
              dialogOpen={(state.snapshot.interactions?.length ?? 0) > 0}
              onThinkingToggle={onThinkingToggle}
            />
          )}
        </div>
      </div>
      {showPill && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          {unread ? '↓ New output' : '↓ latest'}
        </button>
      )}
      {findQuery === null ? (
        <button
          type="button"
          className="find-open"
          onClick={() => setFindQuery('')}
          aria-label="Find in transcript"
          title="Search the committed history loaded in this view"
        >
          Find
        </button>
      ) : (
        <FindBar
          query={findQuery}
          count={matches.length}
          active={activeIdx}
          activeMatch={activeIdx >= 0 ? matches[activeIdx] : null}
          onQuery={setFindQuery}
          onStep={stepFind}
          onClose={closeFind}
        />
      )}
    </div>
  )
}

// useHiddenToolIds keys the hidden-call set on membership rather than array
// identity: the applier replaces live.tools on every streamed tool event, but
// output, progress and verdict deltas never open or retire a call. Holding one
// Set per membership keeps those deltas from re-deriving committed blocks and
// re-rendering their memoized rows.
function useHiddenToolIds(live: AppliedSessionState['live']): ReadonlySet<string> {
  const ids = live?.tools.map((t) => t.id) ?? []
  const [set, setSet] = useState<ReadonlySet<string>>(() => new Set(ids))
  if (!sameMembers(set, ids)) {
    const next = new Set(ids)
    setSet(next)
    return next
  }
  return set
}

// useVerdictChips keys the chip map on the pairs committed rendering can read:
// a hidden call never paints its chip, and a verdict attaches while its call is
// still hidden, so the attach itself joins nothing. The map rebuilds exactly
// when a verdict turns readable, the same change that re-derives blocks.
function useVerdictChips(
  verdicts: AppliedSessionState['permitVerdicts'],
  hidden: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const next = new Map<string, string>()
  for (const v of verdicts) {
    if (!hidden.has(v.id)) next.set(v.id, v.text)
  }
  const [map, setMap] = useState<ReadonlyMap<string, string>>(next)
  if (!sameEntries(map, next)) {
    setMap(next)
    return next
  }
  return map
}

// sameMembers fences the set rebuild: equal size plus every id present means
// the same membership even when the source array identity moved.
function sameMembers(set: ReadonlySet<string>, ids: readonly string[]): boolean {
  if (set.size !== ids.length) return false
  for (const id of ids) {
    if (!set.has(id)) return false
  }
  return true
}

function sameEntries(map: ReadonlyMap<string, string>, next: ReadonlyMap<string, string>): boolean {
  if (map.size !== next.size) return false
  for (const [id, text] of next) {
    if (map.get(id) !== text) return false
  }
  return true
}
