import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

import { EntryBlock } from './EntryBlock'
import { LiveStreamBlock } from './LiveStreamBlock'
import { DiffCard } from './DiffCard'
import { MarkdownBlock } from './MarkdownBlock'
import type { AppliedSessionState } from '../state/eventApplier'
import { deriveBlocks } from '../state/derive'

// Bottom gap still counting as "at the latest row"; scrolling above it
// disengages autoscroll and shows the jump pill.
const stickGap = 60

// TranscriptView renders the committed chain as a virtualized block list keyed
// by entry id, with prints and diffs as transient cards beneath it and the
// pinned live stream at the bottom. Stick-to-bottom autoscroll disengages on
// scroll-up; a pill jumps back to the latest.
export function TranscriptView({
  state,
  loadOlder,
}: {
  state: AppliedSessionState
  loadOlder: () => Promise<boolean>
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stuckRef = useRef(true)
  const anchorRef = useRef<string | null>(null) // block id kept in view across a prepend
  const [showPill, setShowPill] = useState(false)

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
    stuckRef.current = atBottom
    setShowPill(!atBottom && blocks.length > 0)
  }, [blocks.length])

  // Loading older history prepends rows; anchor the previously-first block so
  // the view does not jump, and disengage autoscroll while reading. A dry or
  // failed page drops the anchor instead of letting it fire later.
  const loadOlderAnchored = useCallback(async () => {
    anchorRef.current = blocks[0]?.id ?? null
    stuckRef.current = false
    if (!(await loadOlder())) anchorRef.current = null
  }, [blocks, loadOlder])

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
    stuckRef.current = true
    setShowPill(false)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight // the observer settles measurement
  }, [])

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
              {virtualizer.getVirtualItems().map((item) => (
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
                  <EntryBlock block={blocks[item.index]} />
                </div>
              ))}
            </div>
          )}
          {state.prints.map((p) => (
            <div key={p.id} className="entry print-card card">
              <span className="block-role">printed</span>
              <MarkdownBlock text={p.markdown} />
            </div>
          ))}
          {state.diffs.map((d, i) => (
            <DiffCard key={`${i}-${d.path}`} path={d.path} before={d.before} after={d.after} />
          ))}
          {state.live && <LiveStreamBlock live={state.live} />}
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
