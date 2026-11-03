// Pure split-tree model behind tile mode. A tree is either a pane leaf
// holding that pane's session tabs, or a split node with a direction, a ratio
// for its first child and exactly two children. Every operation returns a new
// tree (unchanged identity when nothing applied), so React and the layout
// profile can compare cheaply and persistence stays a JSON round trip.
//
// Ended sessions stay as tabs until closed, so layouts never shift underneath
// the user; nothing here ever touches the live-session list.

export type SplitDirection = 'row' | 'column' // row: children side by side
export interface TilePane {
  kind: 'pane'
  id: string
  tabs: string[] // session ids, display order
  active: string // session id shown; always a member of tabs
}

export interface TileSplit {
  kind: 'split'
  id: string
  dir: SplitDirection
  ratio: number // first child's share, clamped to [minRatio, 1-minRatio]
  a: TileNode
  b: TileNode
}

export type TileNode = TilePane | TileSplit

const minRatio = 0.12
const maxRatio = 0.88

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(maxRatio, Math.max(minRatio, ratio))
}

let idCounter = 0

function newNodeId(): string {
  idCounter += 1
  return `n${Date.now().toString(36)}${idCounter.toString(36)}`
}

// --- pure operations, each (tree, ...) -> new tree ---

export function paneIds(tree: TileNode | null): string[] {
  const out: string[] = []
  const walk = (node: TileNode): void => {
    if (node.kind === 'pane') {
      out.push(node.id)
      return
    }
    walk(node.a)
    walk(node.b)
  }
  if (tree) walk(tree)
  return out
}

export function findPane(tree: TileNode | null, paneId: string): TilePane | null {
  if (!tree) return null
  if (tree.kind === 'pane') return tree.id === paneId ? tree : null
  return findPane(tree.a, paneId) ?? findPane(tree.b, paneId)
}

// openTab adds a session as a tab, focusing it: on the named pane, else the
// first pane, else as the root pane of an empty tree. A session already
// tabbed anywhere just activates there.
export function openTab(tree: TileNode | null, sessionId: string, paneId?: string): TileNode {
  if (tree === null) return freshPane(sessionId)
  const existing = findSessionPane(tree, sessionId)
  if (existing) return activateTab(tree, existing.id, sessionId)
  const target = (paneId && findPane(tree, paneId)) || firstPane(tree)
  if (!target) return tree
  return withTabs(tree, target.id, (tabs) => [...tabs, sessionId], sessionId)
}

// activateTab shows one existing tab in its pane: the session must already be
// a tab there, anything else keeps the tree identity.
export function activateTab(tree: TileNode, paneId: string, sessionId: string): TileNode {
  return mapPane(tree, paneId, (pane) =>
    !pane.tabs.includes(sessionId) || pane.active === sessionId
      ? pane
      : { ...pane, active: sessionId },
  )
}

// closeTab removes one session's tab; the pane closes when it empties and its
// sibling takes the split's place. The active tab falls to a neighbor.
export function closeTab(tree: TileNode, paneId: string, sessionId: string): TileNode | null {
  const pane = findPane(tree, paneId)
  if (!pane || !pane.tabs.includes(sessionId)) return tree
  if (pane.tabs.length === 1) return removePane(tree, paneId)
  const at = pane.tabs.indexOf(sessionId)
  const next = pane.tabs.filter((id) => id !== sessionId)
  const active =
    pane.active === sessionId ? (next[Math.min(at, next.length - 1)] ?? '') : pane.active
  return replacePane(tree, paneId, { ...pane, tabs: next, active })
}

// removePane drops a whole pane; removing the last one empties the tree.
export function removePane(tree: TileNode, paneId: string): TileNode | null {
  if (tree.kind === 'pane') return tree.id === paneId ? null : tree
  const a = removePane(tree.a, paneId)
  const b = removePane(tree.b, paneId)
  if (a === null) return b
  if (b === null) return a
  if (a === tree.a && b === tree.b) return tree
  return { ...tree, a, b }
}

// splitPane inserts a new pane holding sessionId beside the target: after for
// 'after' (right of / below), before for the other side. Returns the new pane's id.
export function splitPane(
  tree: TileNode,
  paneId: string,
  dir: SplitDirection,
  sessionId: string,
  where: 'before' | 'after',
): { tree: TileNode; paneId: string } {
  const fresh = freshPane(sessionId)
  const insert = (node: TileNode): TileNode => {
    if (node.kind === 'pane') {
      if (node.id !== paneId) return node
      return where === 'after'
        ? { kind: 'split', id: newNodeId(), dir, ratio: 0.5, a: node, b: fresh }
        : { kind: 'split', id: newNodeId(), dir, ratio: 0.5, a: fresh, b: node }
    }
    return { ...node, a: insert(node.a), b: insert(node.b) }
  }
  return { tree: insert(tree), paneId: fresh.id }
}

// moveTab reorders tabs within a pane or moves one across panes. toIndex is
// a tab position in the target pane: insert before it, past the end appends.
// A source pane left empty closes. Same-pane no-ops keep the tree identity so
// drag ghosts settle without churn.
export function moveTab(
  tree: TileNode,
  fromPane: string,
  sessionId: string,
  toPane: string,
  toIndex: number,
): TileNode {
  const source = findPane(tree, fromPane)
  const target = findPane(tree, toPane)
  if (!source || !target || !source.tabs.includes(sessionId)) return tree
  if (fromPane === toPane) {
    const from = source.tabs.indexOf(sessionId)
    // The id is removed before splicing, so a forward target shifts down one
    // slot to stay where the drop-before indicator sat; strip drops append.
    let to: number
    if (toIndex >= target.tabs.length) {
      to = target.tabs.length - 1
    } else {
      to = Math.max(0, toIndex)
      if (from < to) to -= 1
    }
    if (from === to) return tree
    const tabs = source.tabs.filter((id) => id !== sessionId)
    tabs.splice(to, 0, sessionId)
    return replacePane(tree, fromPane, { ...source, tabs })
  }
  // Cross-pane: remove first (closing the source when it empties), then insert.
  const afterRemove = closeTab(tree, fromPane, sessionId)
  if (!afterRemove) return tree // source pane was the whole tree: cannot drop
  const dest = findPane(afterRemove, toPane)
  if (!dest) return tree // closing the source took the target with it
  const at = Math.max(0, Math.min(dest.tabs.length, toIndex))
  const tabs = [...dest.tabs]
  tabs.splice(at, 0, sessionId)
  return replacePane(afterRemove, toPane, { ...dest, tabs, active: sessionId })
}

// setRatio adjusts one split's share, clamped so panes never vanish.
export function setRatio(tree: TileNode, splitId: string, ratio: number): TileNode {
  const walk = (node: TileNode): TileNode => {
    if (node.kind === 'pane') return node
    if (node.id === splitId) return { ...node, ratio: clampRatio(ratio) }
    return { ...node, a: walk(node.a), b: walk(node.b) }
  }
  return walk(tree)
}

// --- internal helpers ---

// firstPane returns the leftmost pane of the tree, null when empty.
function firstPane(tree: TileNode): TilePane | null {
  if (tree.kind === 'pane') return tree
  return firstPane(tree.a) ?? firstPane(tree.b)
}

// Panes per row in grids tileFor generates.
const tileRowCap = 3

// tileFor lays one pane per session id out as a balanced grid of equal panes:
// rows hold at most three, wrapping over as few rows as possible with larger
// rows first (5 → 3+2; 7 → 3+2+2), joined by column splits. Reading order is
// left-to-right then top-down. ids must be non-empty.
export function tileFor(ids: string[]): TileNode {
  if (ids.length === 0) throw new Error('tileFor requires at least one session id')
  const rows = Math.ceil(ids.length / tileRowCap)
  let at = 0
  const rowTrees: TileNode[] = []
  for (let row = 0; row < rows; row++) {
    // leading rows take the remainder, so row sizes come out larger-first
    const count = Math.floor(ids.length / rows) + (row < ids.length % rows ? 1 : 0)
    rowTrees.push(chainSplits('row', ids.slice(at, at + count).map(freshPane)))
    at += count
  }
  return chainSplits('column', rowTrees)
}

// freshPane builds a pane holding one session as its only active tab.
function freshPane(sessionId: string): TilePane {
  return { kind: 'pane', id: newNodeId(), tabs: [sessionId], active: sessionId }
}

// chainSplits nests nodes along dir with ratios that give every node an equal
// share: k nodes split as 1/k, then 1/(k-1) of the rest, and so on.
function chainSplits(dir: SplitDirection, nodes: TileNode[]): TileNode {
  let merged = nodes[nodes.length - 1]
  for (let i = nodes.length - 2; i >= 0; i--) {
    merged = {
      kind: 'split',
      id: newNodeId(),
      dir,
      ratio: 1 / (nodes.length - i),
      a: nodes[i],
      b: merged,
    }
  }
  return merged
}

// findSessionPane locates the pane tabbing a session, null when nowhere open.
function findSessionPane(tree: TileNode | null, sessionId: string): TilePane | null {
  if (!tree) return null
  if (tree.kind === 'pane') return tree.tabs.includes(sessionId) ? tree : null
  return findSessionPane(tree.a, sessionId) ?? findSessionPane(tree.b, sessionId)
}

function withTabs(
  tree: TileNode,
  paneId: string,
  update: (tabs: string[]) => string[],
  active?: string,
): TileNode {
  return mapPane(tree, paneId, (pane) => {
    const tabs = update(pane.tabs)
    return { ...pane, tabs, active: active ?? pane.active }
  })
}

function mapPane(tree: TileNode, paneId: string, fn: (pane: TilePane) => TilePane): TileNode {
  if (tree.kind === 'pane') return tree.id === paneId ? fn(tree) : tree
  const a = mapPane(tree.a, paneId, fn)
  const b = mapPane(tree.b, paneId, fn)
  if (a === tree.a && b === tree.b) return tree
  return { ...tree, a, b }
}

function replacePane(tree: TileNode, paneId: string, pane: TilePane): TileNode {
  return mapPane(tree, paneId, () => pane)
}

// --- serialization: the layout profile persists the tree as plain JSON ---

export function parseTree(raw: unknown): TileNode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const node = raw as Record<string, unknown>
  if (node.kind === 'pane') {
    if (typeof node.id !== 'string' || node.id === '') return null
    if (!Array.isArray(node.tabs) || !node.tabs.every((t) => typeof t === 'string' && t !== '')) {
      return null
    }
    const tabs = node.tabs as string[]
    if (tabs.length === 0) return null
    const active =
      typeof node.active === 'string' && tabs.includes(node.active) ? node.active : tabs[0]
    return { kind: 'pane', id: node.id, tabs, active }
  }
  if (node.kind !== 'split') return null
  if (typeof node.id !== 'string' || node.id === '') return null
  if (node.dir !== 'row' && node.dir !== 'column') return null
  const a = parseTree(node.a)
  const b = parseTree(node.b)
  if (!a || !b) return null
  const ratio = typeof node.ratio === 'number' && Number.isFinite(node.ratio) ? node.ratio : 0.5
  return { kind: 'split', id: node.id, dir: node.dir, ratio: clampRatio(ratio), a, b }
}
