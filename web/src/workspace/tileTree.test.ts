import { describe, expect, it } from 'vitest'

import {
  clampRatio,
  closeTab,
  findPane,
  moveTab,
  openTab,
  paneIds,
  parseTree,
  removePane,
  serializeTree,
  setRatio,
  splitPane,
} from './tileTree'
import type { TileNode, TilePane, TileSplit } from './tileTree'

function pane(id: string, tabs: string[], active?: string): TilePane {
  return { kind: 'pane', id, tabs, active: active ?? tabs[0] }
}

function split(
  id: string,
  dir: 'row' | 'column',
  ratio: number,
  a: TileNode,
  b: TileNode,
): TileSplit {
  return { kind: 'split', id, dir, ratio, a, b }
}

// twoByTwo builds row(a | b) over column(c | d), ids matching their pane.
function twoByTwo(): TileNode {
  return split(
    'row1',
    'row',
    0.5,
    pane('left', ['s1']),
    split('col1', 'column', 0.4, pane('rightTop', ['s2']), pane('rightBottom', ['s3'])),
  )
}

describe('tile tree operations', () => {
  it('opens tabs, activates existing sessions and roots an empty tree', () => {
    expect(openTab(null, 's1')).toMatchObject({ kind: 'pane', tabs: ['s1'], active: 's1' })

    const tree = openTab(null, 's1')
    const grown = openTab(tree, 's2', (tree as TilePane).id)
    const root = grown as TilePane
    expect(root.tabs).toEqual(['s1', 's2'])
    expect(root.active).toBe('s2')

    // a session already open just activates its pane
    const again = openTab(grown, 's1')
    expect(again).not.toBe(grown)
    expect((again as TilePane).active).toBe('s1')
  })

  it('splits panes in a direction and reports the new pane', () => {
    const tree = pane('p1', ['s1'])
    const { tree: splitTree, paneId } = splitPane(tree, 'p1', 'column', 's2', 'after')

    const node = splitTree as TileSplit
    expect(node.kind).toBe('split')
    expect(node.dir).toBe('column')
    expect(node.ratio).toBe(0.5)
    expect((node.a as TilePane).id).toBe('p1')
    expect((node.b as TilePane).tabs).toEqual(['s2'])
    expect(paneId).toBe((node.b as TilePane).id)

    const before = splitPane(tree, 'p1', 'row', 's2', 'before')
    expect(((before.tree as TileSplit).a as TilePane).tabs).toEqual(['s2'])
  })

  it('closes tabs, keeps neighbors active and rebalances closed panes away', () => {
    const tree = twoByTwo()

    // closing a middle tab falls active to a neighbor
    const withTabs = openTab(tree, 's9', 'rightTop') as TileSplit
    const trimmed = closeTab(withTabs, 'rightTop', 's2')
    const after = findPane(trimmed!, 'rightTop')!
    expect(after.tabs).toEqual(['s9'])
    expect(after.active).toBe('s9')

    // removing one leaf of a split replaces the split with its sibling subtree
    const removed = removePane(tree, 'left')
    expect(removed).toMatchObject({ kind: 'split', id: 'col1' })

    // closing the only tab of the only pane empties the tree
    expect(closeTab(pane('solo', ['s1']), 'solo', 's1')).toBeNull()

    // closing a leaf collapses only its own split, keeping the outer shape
    const oneSided = closeTab(twoByTwo(), 'rightBottom', 's3') as TileSplit
    expect(oneSided).toMatchObject({ kind: 'split', id: 'row1' })
    expect(oneSided.b).toMatchObject({ kind: 'pane', id: 'rightTop' })
  })

  it('moves tabs within and across panes, closing emptied sources', () => {
    const tree = twoByTwo()

    // reorder inside one pane
    const added = openTab(tree, 's9', 'left') as TileSplit
    const left = findPane(added, 'left')!
    const reordered = moveTab(added, left.id, 's9', left.id, 0)
    expect(findPane(reordered, 'left')!.tabs).toEqual(['s9', 's1'])

    // move across panes; the emptied source pane disappears
    const moved = moveTab(tree, 'left', 's1', 'rightTop', 0) as TileSplit
    expect(moved.kind).toBe('split')
    expect(findPane(moved, 'rightTop')!.tabs).toEqual(['s1', 's2'])
    expect(findPane(moved, 'left')).toBeNull()

    // same-position moves keep identity so drags settle without churn
    expect(moveTab(tree, 'left', 's1', 'left', 0)).toBe(tree)

    // dropping the root pane's only tab nowhere leaves the tree alone
    const solo = pane('solo', ['s1'])
    expect((moveTab(solo, 'solo', 's1', 'solo', 5) as TilePane).tabs).toEqual(['s1'])
  })

  it('clamps ratios so panes never vanish', () => {
    expect(clampRatio(0.5)).toBe(0.5)
    expect(clampRatio(-1)).toBe(0.12)
    expect(clampRatio(2)).toBe(0.88)
    expect(clampRatio(Number.NaN)).toBe(0.5)

    const tree = twoByTwo()
    expect((setRatio(tree, 'row1', 0.9) as TileSplit).ratio).toBe(0.88)
    const adjusted = setRatio(tree, 'col1', 0.1) as TileSplit
    expect((adjusted.b as TileSplit).ratio).toBe(0.12)
    expect(((setRatio(tree, 'col1', 0.7) as TileSplit).b as TileSplit).ratio).toBe(0.7)
  })

  it('round-trips through JSON and rejects corrupt trees', () => {
    const tree = twoByTwo()
    expect(parseTree(JSON.parse(JSON.stringify(serializeTree(tree))))).toEqual(tree)
    expect(parseTree(null)).toBeNull()

    const bad: unknown[] = [
      42,
      { kind: 'pane' },
      { kind: 'pane', id: 'p', tabs: [] },
      { kind: 'split', id: 's', dir: 'diagonal', a: pane('a', ['x']), b: pane('b', ['y']) },
      { kind: 'split', id: 's', dir: 'row', ratio: 0.5, a: pane('a', ['x']) },
    ]
    for (const raw of bad) expect(parseTree(raw)).toBeNull()

    // ratio and active repair themselves rather than failing the load
    const healed = parseTree({
      kind: 'split',
      id: 's',
      dir: 'row',
      ratio: 9,
      a: { kind: 'pane', id: 'a', tabs: ['x'], active: 'gone' },
      b: { kind: 'pane', id: 'b', tabs: ['y'] },
    }) as TileSplit
    expect(healed.ratio).toBe(0.88)
    expect((healed.a as TilePane).active).toBe('x')
  })

  it('lists panes in document order', () => {
    expect(paneIds(twoByTwo())).toEqual(['left', 'rightTop', 'rightBottom'])
    expect(paneIds(null)).toEqual([])
  })
})
