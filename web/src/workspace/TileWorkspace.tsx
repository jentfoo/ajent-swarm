import { useCallback, useMemo, useRef, useState } from 'react'
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react'

import { useSwarm } from '../providers/swarm'
import { useAuth } from '../providers/auth'
import { useWorkspace } from '../providers/workspace'
import SessionView from '../screens/SessionView'
import { displayName } from '../session/names'
import { useWorkspaceKeys } from './keys'
import type { Direction } from './keys'
import { ShortcutOverlay } from './ShortcutOverlay'
import type { AttentionItem } from './attention'
import { ChildState } from '../api/types'
import { closeTab, findPane, moveTab, openTab, paneIds, setRatio, splitPane } from './tileTree'
import type { TileNode, TilePane, SplitDirection } from './tileTree'

const resizeStep = 0.05

// TileWorkspace treats sessions like windows in a tiling manager: a split
// tree with per-pane tab strips, drag-to-split and drag-to-reorder, full
// keyboard management. The tree persists in the layout profile, so reloads
// and mode switches never disturb the arrangement; ended sessions stay as
// tabs with their final state until closed.
export default function TileWorkspace() {
  const { sessions } = useSwarm()
  const auth = useAuth()
  const { profile, setTileLayout, itemFor } = useWorkspace()
  const { tree, focusedPaneId } = profile.tile

  const [showShortcuts, setShowShortcuts] = useState(false)
  const [dropHint, setDropHint] = useState<{ paneId: string; zone: string } | null>(null)
  const dragRef = useRef<{ sessionId: string; paneId: string } | null>(null)
  // Drop zones render only while a tab is in flight, so they never stand
  // between the pointer and the hosted views.
  const [dragging, setDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const focused = useMemo(() => {
    const ids = paneIds(tree)
    if (ids.length === 0) return ''
    return focusedPaneId !== undefined && ids.includes(focusedPaneId) ? focusedPaneId : ids[0]
  }, [tree, focusedPaneId])

  const commit = useCallback(
    (next: TileNode | null, focus?: string) => {
      setTileLayout({ tree: next, focusedPaneId: focus })
    },
    [setTileLayout],
  )

  const focusPane = useCallback((paneId: string) => commit(tree, paneId), [commit, tree])

  const nameFor = useCallback(
    (sessionId: string) => {
      const s = sessions.find((row) => row.sessionId === sessionId)
      return s ? displayName(s, auth.home) : shortID(sessionId)
    },
    [sessions, auth.home],
  )

  // The next session nowhere open in the tree, for splits and pickers.
  const nextCandidate = useCallback((): string | null => {
    const open = new Set<string>()
    const walk = (node: TileNode | null) => {
      if (!node) return
      if (node.kind === 'pane') node.tabs.forEach((t) => open.add(t))
      else {
        walk(node.a)
        walk(node.b)
      }
    }
    walk(tree)
    return sessions.find((s) => !open.has(s.sessionId))?.sessionId ?? null
  }, [sessions, tree])

  const closeInPane = useCallback(
    (paneId: string, sessionId: string) => {
      if (!tree) return
      commit(closeTab(tree, paneId, sessionId), paneId)
    },
    [commit, tree],
  )

  // openSession places a session beside the others: as a tab in the chosen
  // pane, or split out into a fresh one. Sessions already open just activate.
  const openInTree = useCallback(
    (sessionId: string, paneId?: string, split?: boolean) => {
      if (!tree) {
        commit(openTab(null, sessionId))
        return
      }
      if (split && paneId) {
        const { tree: next, paneId: fresh } = splitPane(tree, paneId, 'row', sessionId, 'after')
        commit(next, fresh)
        return
      }
      commit(openTab(tree, sessionId, paneId), paneId)
    },
    [commit, tree],
  )

  const splitFocused = useCallback(
    (dir: SplitDirection) => {
      if (!tree) return
      const sessionId = nextCandidate()
      if (sessionId === null) return
      const { tree: next, paneId } = splitPane(tree, focused, dir, sessionId, 'after')
      commit(next, paneId)
    },
    [commit, focused, nextCandidate, tree],
  )

  const moveFocus = useCallback(
    (dir: Direction) => {
      const container = containerRef.current
      if (!container || !focused) return
      const current = container.querySelector<HTMLElement>(`[data-pane-id="${focused}"]`)
      if (!current) return
      const from = current.getBoundingClientRect()
      const horizontal = dir === 'left' || dir === 'right'
      let best: { id: string; gap: number } | null = null
      for (const el of container.querySelectorAll<HTMLElement>('[data-pane-id]')) {
        const id = el.dataset.paneId
        if (!id || id === focused) continue
        const to = el.getBoundingClientRect()
        const overlap = horizontal
          ? Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top)
          : Math.min(from.right, to.right) - Math.max(from.left, to.left)
        if (overlap <= 0) continue
        const gap =
          dir === 'left'
            ? from.left - to.right
            : dir === 'right'
              ? to.left - from.right
              : dir === 'up'
                ? from.top - to.bottom
                : to.top - from.bottom
        const toward =
          dir === 'left'
            ? to.right <= from.left + 1
            : dir === 'right'
              ? to.left >= from.right - 1
              : dir === 'up'
                ? to.bottom <= from.top + 1
                : to.top >= from.bottom - 1
        if (!toward || gap < 0) continue
        if (best === null || gap < best.gap) best = { id, gap }
      }
      if (best) focusPane(best.id)
    },
    [focused, focusPane],
  )

  const resizeFocused = useCallback(
    (dir: Direction) => {
      if (!tree || !focused) return
      const want = dir === 'left' || dir === 'right' ? 'row' : 'column'
      // Walk to the focused pane recording the path, then take the nearest
      // split on the resize axis.
      const path: { node: TileNode & { kind: 'split' }; inA: boolean }[] = []
      const walk = (node: TileNode): boolean => {
        if (node.kind === 'pane') return node.id === focused
        const frame = { node, inA: true }
        path.push(frame)
        if (walk(node.a)) return true
        frame.inA = false
        if (walk(node.b)) return true
        path.pop()
        return false
      }
      if (!walk(tree)) return
      const hit = [...path].reverse().find((p) => p.node.dir === want)
      if (!hit) return
      const growing = (dir === 'right' || dir === 'down') === hit.inA
      commit(setRatio(tree, hit.node.id, hit.node.ratio + (growing ? resizeStep : -resizeStep)))
    },
    [commit, focused, tree],
  )

  useWorkspaceKeys({
    onPaneClose: () => {
      if (!tree) return
      const pane = findPane(tree, focused)
      if (!pane) return
      commit(closeTab(tree, pane.id, pane.active), pane.id)
    },
    onSplitRight: () => splitFocused('row'),
    onSplitDown: () => splitFocused('column'),
    onFocusDirection: moveFocus,
    onResize: resizeFocused,
    onDigit: (position) => {
      const target = paneIds(tree)[position - 1]
      if (target) focusPane(target)
    },
    onShortcuts: () => setShowShortcuts(true),
  })

  // --- drag and drop ---

  const startDrag = (ev: DragEvent, sessionId: string, paneId: string) => {
    dragRef.current = { sessionId, paneId }
    ev.dataTransfer.setData('text/plain', sessionId) // Firefox drags need data
    ev.dataTransfer.effectAllowed = 'move'
    setDragging(true)
  }

  const endDrag = useCallback(() => {
    dragRef.current = null
    setDropHint(null)
    setDragging(false)
  }, [])

  const dropOnPane = (paneId: string, zone: string) => {
    const drag = dragRef.current
    if (!drag || !tree) return endDrag()
    if (zone === 'strip' || zone.startsWith('tab:')) {
      const index = zone.startsWith('tab:') ? Number(zone.slice(4)) : Number.MAX_SAFE_INTEGER
      commit(moveTab(tree, drag.paneId, drag.sessionId, paneId, index), paneId)
      return endDrag()
    }
    // An edge drop splits the pane, moving the tab into the fresh half.
    const stripped = closeTab(tree, drag.paneId, drag.sessionId)
    if (!stripped) return endDrag() // the tree was that one tab: nothing to split
    if (!findPane(stripped, paneId)) return endDrag() // target left with the source
    const dir: SplitDirection = zone === 'left' || zone === 'right' ? 'row' : 'column'
    const where = zone === 'left' || zone === 'top' ? 'before' : 'after'
    const { tree: next, paneId: fresh } = splitPane(stripped, paneId, dir, drag.sessionId, where)
    commit(next, fresh)
    endDrag()
  }

  const allowDrop = (ev: DragEvent, paneId: string, zone: string) => {
    ev.preventDefault()
    ev.stopPropagation()
    setDropHint((prev) => (prev?.paneId === paneId && prev.zone === zone ? prev : { paneId, zone }))
  }

  const resizeSplit = useCallback(
    (splitId: string, ratio: number) => {
      if (tree) commit(setRatio(tree, splitId, ratio))
    },
    [commit, tree],
  )

  return (
    <div className="workspace tile-workspace" ref={containerRef}>
      {tree === null ? (
        <div className="tile-empty">
          <p className="muted">No panes open.</p>
          <div className="chips">
            {sessions
              .filter((s) => s.state === ChildState.Online)
              .map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  onClick={() => commit(openTab(null, s.sessionId))}
                >
                  {nameFor(s.sessionId)}
                </button>
              ))}
            {sessions.filter((s) => s.state === ChildState.Online).length === 0 && (
              <span>No live sessions to open.</span>
            )}
          </div>
        </div>
      ) : (
        <NodeView
          node={tree}
          focused={focused}
          dragging={dragging}
          dropHint={dropHint}
          itemFor={itemFor}
          nameFor={nameFor}
          onFocusPane={focusPane}
          onCloseTab={closeInPane}
          onOpenSession={openInTree}
          onStartDrag={startDrag}
          onDropZone={dropOnPane}
          onAllowDrop={allowDrop}
          onDragEnd={endDrag}
          onResizeSplit={resizeSplit}
        />
      )}
      {showShortcuts && <ShortcutOverlay mode="tile" onClose={() => setShowShortcuts(false)} />}
    </div>
  )
}

interface NodeProps {
  node: TileNode
  focused: string
  dragging: boolean
  dropHint: { paneId: string; zone: string } | null
  itemFor: (sessionId: string) => AttentionItem | undefined
  nameFor: (sessionId: string) => string
  onFocusPane: (paneId: string) => void
  onCloseTab: (paneId: string, sessionId: string) => void
  onOpenSession: (sessionId: string, paneId?: string, split?: boolean) => void
  onStartDrag: (ev: DragEvent, sessionId: string, paneId: string) => void
  onDropZone: (paneId: string, zone: string) => void
  onAllowDrop: (ev: DragEvent, paneId: string, zone: string) => void
  onDragEnd: () => void
  onResizeSplit: (splitId: string, ratio: number) => void
}

// NodeView renders one split or pane; splits lay their children out along the
// direction with the ratio on the first child.
function NodeView(props: NodeProps) {
  const { node } = props
  if (node.kind === 'pane') {
    return <PaneView {...props} pane={node} />
  }
  const style = { flex: `0 0 calc(${node.ratio * 100}% - 3px)` }
  return (
    <div className={`tile-split ${node.dir === 'row' ? 'split-row' : 'split-column'}`}>
      <div className="tile-cell" style={style}>
        <NodeView {...props} node={node.a} />
      </div>
      <Divider dir={node.dir} splitId={node.id} onResize={props.onResizeSplit} />
      <div className="tile-cell" style={{ flex: 1 }}>
        <NodeView {...props} node={node.b} />
      </div>
    </div>
  )
}

// Divider drags to resize its split: the pointer position within the split's
// box becomes the ratio.
function Divider({
  dir,
  splitId,
  onResize,
}: {
  dir: SplitDirection
  splitId: string
  onResize: (splitId: string, ratio: number) => void
}) {
  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const box = ev.currentTarget.parentElement
    if (!box) return
    const rect = box.getBoundingClientRect()
    ev.preventDefault()
    const onMove = (move: PointerEvent) => {
      const ratio =
        dir === 'row'
          ? (move.clientX - rect.left) / rect.width
          : (move.clientY - rect.top) / rect.height
      onResize(splitId, ratio)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div
      className={`tile-divider ${dir === 'row' ? 'v' : 'h'}`}
      role="separator"
      aria-orientation={dir === 'row' ? 'vertical' : 'horizontal'}
      onPointerDown={onPointerDown}
    />
  )
}

// PaneView is one pane: its tab strip above a hosted SessionView, with an
// add-session picker, drop zones for tabs (strip) and edges (split).
function PaneView({
  pane,
  focused,
  dragging,
  dropHint,
  itemFor,
  nameFor,
  onFocusPane,
  onCloseTab,
  onOpenSession,
  onStartDrag,
  onDropZone,
  onAllowDrop,
  onDragEnd,
}: NodeProps & { pane: TilePane }) {
  const isFocused = pane.id === focused
  const hint = dropHint?.paneId === pane.id ? dropHint.zone : null

  // A tab badges while its attention rises and it is not the focused view.
  const badgeFor = (sessionId: string): string | null => {
    const item = itemFor(sessionId)
    if (item === undefined) return null
    if (item.kind !== 'needs-input' && item.kind !== 'needs-review') return null
    if (isFocused && pane.active === sessionId) return null
    return item.kind
  }

  const drop = (zone: string) => (ev: DragEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
    onDropZone(pane.id, zone)
  }

  return (
    <div
      className={`tile-pane ${isFocused ? 'focused' : ''}`}
      data-pane-id={pane.id}
      onPointerDown={() => onFocusPane(pane.id)}
    >
      <div
        className="tile-tabs"
        onDragOver={(ev) => onAllowDrop(ev, pane.id, 'strip')}
        onDrop={drop('strip')}
      >
        {pane.tabs.map((sessionId, index) => {
          const badge = badgeFor(sessionId)
          return (
            <div
              key={sessionId}
              className={`tile-tab ${pane.active === sessionId ? 'active' : ''} ${
                hint === `tab:${index}` ? 'drop-before' : ''
              }`}
              draggable
              onDragStart={(ev) => onStartDrag(ev, sessionId, pane.id)}
              onDragEnd={onDragEnd}
              onDragOver={(ev) => onAllowDrop(ev, pane.id, `tab:${index}`)}
              onDrop={drop(`tab:${index}`)}
              onClick={() => onFocusPane(pane.id)}
              title={nameFor(sessionId)}
            >
              {badge !== null && <span className={`tab-badge ${badge}`} aria-label={badge} />}
              <span className="tab-name">{nameFor(sessionId)}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${nameFor(sessionId)}`}
                onClick={(ev) => {
                  ev.stopPropagation()
                  onCloseTab(pane.id, sessionId)
                }}
              >
                ×
              </button>
            </div>
          )
        })}
        <SessionPicker
          nameFor={nameFor}
          onOpen={(sessionId, split) => onOpenSession(sessionId, pane.id, split)}
        />
      </div>

      {dragging &&
        (['top', 'bottom', 'left', 'right'] as const).map((zone) => (
          <div
            key={zone}
            className={`drop-edge ${zone} ${hint === zone ? 'hinted' : ''}`}
            onDragOver={(ev) => onAllowDrop(ev, pane.id, zone)}
            onDrop={drop(zone)}
          />
        ))}

      <div className="tile-body">
        <SessionView sessionId={pane.active} />
      </div>
    </div>
  )
}

// SessionPicker is the tab strip's + affordance: every known session opens as
// a tab here (a second button splits it into its own pane), so several
// sessions stream side by side without touching the keyboard.
function SessionPicker({
  nameFor,
  onOpen,
}: {
  nameFor: (sessionId: string) => string
  onOpen: (sessionId: string, split?: boolean) => void
}) {
  const { sessions } = useSwarm()
  const ref = useRef<HTMLDetailsElement>(null)
  // Live sessions first, then the rest; each keeps its listing order.
  const ordered = useMemo(() => {
    const live = sessions.filter((s) => s.state === ChildState.Online)
    const rest = sessions.filter((s) => s.state !== ChildState.Online)
    return [...live, ...rest]
  }, [sessions])

  const close = () => {
    if (ref.current?.open) ref.current.open = false
  }
  const pick = (sessionId: string, split?: boolean) => {
    close()
    onOpen(sessionId, split)
  }

  return (
    <details className="tile-add" ref={ref} title="Open a session in this pane">
      <summary aria-label="Add a session to this pane">+</summary>
      {ordered.length === 0 ? (
        <div className="tile-menu muted">No sessions known.</div>
      ) : (
        <div className="tile-menu" role="menu">
          {ordered.map((s) => (
            <div key={s.sessionId} className="tile-menu-row">
              <button
                type="button"
                role="menuitem"
                title={nameFor(s.sessionId)}
                onClick={() => pick(s.sessionId)}
              >
                {nameFor(s.sessionId)}
              </button>
              <button
                type="button"
                className="tile-menu-split"
                aria-label={`Split pane with ${nameFor(s.sessionId)}`}
                title="Open in a new split beside this pane"
                onClick={() => pick(s.sessionId, true)}
              >
                ⊞
              </button>
            </div>
          ))}
        </div>
      )}
    </details>
  )
}

function shortID(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8) + '…'
}
