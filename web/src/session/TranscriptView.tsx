import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { EntryBlock } from './EntryBlock'
import { LiveStreamBlock } from './LiveStreamBlock'
import { SubAgentChips } from './ToolCallCard'
import { subAgentRows } from './StatusBar'
import { DiffCard } from './DiffCard'
import { MarkdownBlock } from './MarkdownBlock'
import type { AppliedSessionState, DiffView } from '../state/eventApplier'
import { deriveBlocks } from '../state/derive'

// Bottom gap still counting as "at the latest row"; scrolling above it
// disengages autoscroll and shows the jump pill.
const stickGap = 60

// pullDownPx is how far a downward drag may rubber-band at the very top of the
// history before the mobile pull-to-latest gesture fires.
const pullDownPx = 64

// TranscriptView renders the committed chain as a virtualized block list keyed
// by entry id, with each anchored diff riding its block's row, unanchored ones
// trailing beneath, and the pinned live stream at the bottom. Stick-to-bottom
// autoscroll disengages on scroll-up; a pill jumps back to the latest. A
// sessionId change (swapping sessions inside one hosted view) re-lands on the
// latest too.
export function TranscriptView({
  sessionId = '',
  state,
  loadOlder,
  pullDownToLatest = false, // mobile: rubber-band at the top jumps to latest
  onThinkingToggle,
}: {
  sessionId?: string
  state: AppliedSessionState
  loadOlder: () => Promise<boolean>
  pullDownToLatest?: boolean
  // Threaded to the live thinking panel so user toggles reach the applier;
  // surfaces that cannot dispatch keep the defaults instead.
  onThinkingToggle?: (open: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stuckRef = useRef(true)
  const anchorRef = useRef<string | null>(null) // block id kept in view across a prepend
  const lastTopRef = useRef(0) // previous scrollTop, for the direction check
  const [showPill, setShowPill] = useState(false)

  const setStuck = useCallback((stuck: boolean) => {
    stuckRef.current = stuck
    setShowPill(!stuck)
  }, [])

  // Calls still painting live hide their committed twins until a carrier's
  // results fold and the buffer retires them: one card per call, not two.
  const hideLiveToolIds = useMemo(
    () => new Set(state.live?.tools.map((t) => t.id)),
    [state.live?.tools],
  )

  // Derivation re-runs only when the chain object or the live tool set
  // changes; streaming deltas touch neither, so settled history renders once.
  // The entries map mutates in place with a stable identity, which is why the
  // chain is the trigger.
  const blocks = useMemo(
    () => deriveBlocks(state.chain.ids, state.entries, hideLiveToolIds),
    [state.chain, state.entries, hideLiveToolIds],
  )

  // Diffs anchor to the block they arrived after; a card sits inside its row
  // wrapper so the virtualizer measures them together. Anchors that left the
  // retained chain (rewound away, never committed) fall back below it.
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

  // TanStack Virtual returns unstable function values by design; the compiler
  // opt-out is documented upstream and safe with our row keys.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => blocks[i].id,
  })

  // One ResizeObserver over the content wrapper keeps autoscroll honest
  // through dynamic row measurement, live text growth and late image loads.
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const ro = new ResizeObserver(() => {
      if (stuckRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    el.scrollTop = el.scrollHeight // land on the latest history, not the top
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < stickGap
    // Only a genuine upward scroll disengages autoscroll. Every other
    // above-the-gap reading is a transient of programmatic adjustment or
    // content growth: thinking blocks expanding and collapsing and the
    // virtualizer compensating both move scrollTop mid-pin, and treating
    // those as user scrolls is what used to drop the follow mid-stream.
    if (atBottom) {
      setStuck(true)
    } else if (el.scrollTop < lastTopRef.current) {
      setStuck(false)
    }
    lastTopRef.current = el.scrollTop
  }, [setStuck])

  // Loading older history prepends rows; anchor the previously-first block so
  // the view does not jump, and disengage autoscroll while reading. A dry or
  // failed page drops the anchor instead of letting it fire later.
  const loadOlderAnchored = useCallback(async () => {
    anchorRef.current = blocks[0]?.id ?? null
    setStuck(false)
    if (!(await loadOlder())) anchorRef.current = null
  }, [blocks, loadOlder, setStuck])

  useEffect(() => {
    if (anchorRef.current === null) return
    const id = anchorRef.current
    anchorRef.current = null
    // Block indexes are what the virtualizer scrolls by; chain positions skip
    // entries that derive to no block.
    const idx = blocks.findIndex((b) => b.id === id)
    if (idx > 0) virtualizer.scrollToIndex(idx, { align: 'start' })
  }, [blocks, virtualizer])

  const jumpToLatest = useCallback(() => {
    setStuck(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight // the observer settles measurement
  }, [setStuck])

  // A hosted view swaps sessions in place; the new session's transcript
  // always opens on its latest, never wherever the previous one sat.
  const lastSessionRef = useRef(sessionId)
  useEffect(() => {
    if (lastSessionRef.current === sessionId) return
    lastSessionRef.current = sessionId
    jumpToLatest()
  }, [sessionId, jumpToLatest])

  // Pull-to-latest: while already at the top of history, dragging further down
  // is dead overscroll — exactly where a gesture cannot fight scrolling. The
  // drag distance rides touchmove so it works through the rubber band.
  useEffect(() => {
    if (!pullDownToLatest) return
    const el = scrollRef.current
    if (!el) return
    let startY: number | null = null
    const begin = (ev: TouchEvent) => {
      startY = ev.touches[0]?.clientY ?? null
    }
    const move = (ev: TouchEvent) => {
      if (startY === null || el.scrollTop > 0) return
      const dy = (ev.touches[0]?.clientY ?? 0) - startY
      if (dy >= pullDownPx) {
        startY = null
        jumpToLatest()
      }
    }
    const end = () => {
      startY = null
    }
    el.addEventListener('touchstart', begin, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', end, { passive: true })
    return () => {
      el.removeEventListener('touchstart', begin)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
    }
  }, [pullDownToLatest, jumpToLatest])

  return (
    <div className="transcript-wrap" aria-label="Transcript">
      {!state.chain.rooted && state.chain.ids.length > 0 && (
        <p>
          <button type="button" onClick={() => void loadOlderAnchored()}>
            Load older history
          </button>
        </p>
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
            <>
              {/* sub-agent jobs show as live chips before their cards open */}
              <SubAgentChips rows={subAgentRows(state.snapshot.activity)} />
              <LiveStreamBlock
                live={state.live}
                activity={state.snapshot.activity}
                onThinkingToggle={onThinkingToggle}
              />
            </>
          )}
        </div>
      </div>
      {showPill && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          ↓ latest
        </button>
      )}
    </div>
  )
}
