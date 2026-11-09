import { useEffect, useRef } from 'react'

// stampKey marks the history entries this module pushes or adopts, so one
// layer's close never consumes an entry pushed for another and every consume
// is matched by the stamp it lands on, never by the absence of one.
const stampKey = 'swarmOverlay'

interface Layer {
  stamp: number
  close: () => void
}

// one consume traversal in flight: the dead entry it departs from and the
// stamped entry directly below, where its popstate lands
interface Step {
  from: number
  land: number
}

// stamped entries by stamp. A layer entry knows the stamped entry it sits on
// an adopted entry only marks foreign ground (a router entry), so a consume
// never departs from one.
type Entry = { below: number; layer: true } | { layer: false }

// Open layers, outermost last.
let layers: Layer[] = []
// the one consume traversal in flight, null once landed or superseded
let pending: Step | null = null
const entries = new Map<number, Entry>()
let nextStamp = 1
let bound = false

// entryHere reads this module's stamp off the current history entry.
function entryHere(): number | undefined {
  const state: unknown = window.history.state
  if (typeof state !== 'object' || state === null) return undefined
  const stamp = (state as Record<string, unknown>)[stampKey]
  return typeof stamp === 'number' ? stamp : undefined
}

// consumeHere steps back over the current entry when it is a dead layer's
// own: entries a live layer owns, adopted ground and entries the router moved
// past are left alone, and one already being consumed is consumed once.
function consumeHere(): void {
  const stamp = entryHere()
  if (stamp === undefined) return
  const entry = entries.get(stamp)
  if (entry === undefined || !entry.layer) return
  if (layers.some((l) => l.stamp === stamp)) return
  if (pending !== null && pending.from === stamp) return
  pending = { from: stamp, land: entry.below }
  window.history.back()
}

const onPop = () => {
  const here = entryHere()
  const mine = pending !== null && pending.land === here
  if (pending !== null) {
    // the traversal landed where it queued for, or was canceled or superseded
    // by whatever landing arrived instead, its expectation dies either way
    pending = null
  }
  if (mine) {
    // our own consume stepped onto the entry it queued for, the router has
    // nothing new to show for it either. A stacked teardown lands on another
    // dead entry below: keep consuming until an entry something else owns is
    // current
    consumeHere()
    return
  }
  const top = layers[layers.length - 1]
  if (top !== undefined) top.close()
}

// useOverlayBack ties one overlay layer to history for as long as it is
// mounted. Opening pushes an entry beside the current one, so platform back
// and the browser back button close the topmost overlay instead of leaving
// the session, and a layer's own close (drag, Escape, timeout) consumes its
// entry rather than leaving it behind.
//
// The two directions compose without looping: pop events close overlays, and
// overlay-initiated closes only step back over an entry this module pushed
// that no live layer still owns. A router navigation on top recycles or
// buries the entry, so closing then leaves history alone. An unstamped
// landing reads as a real navigation, and a consume dies with the next push
// or foreign landing (browsers cancel superseded traversals), so it can
// never swallow a later genuine back.
export function useOverlayBack(onClose: () => void): void {
  // latest onClose, so the close paths never resubscribe
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  useEffect(() => {
    if (!bound) {
      bound = true
      window.addEventListener('popstate', onPop)
    }

    // this open's push cancels any traversal still queued, a step that will
    // never land must not outlive it
    pending = null

    // adopt the entry below when it carries no stamp of ours: every step then
    // lands on a stamped entry, so an unmarked one always reads as foreign
    let below = entryHere()
    if (below === undefined) {
      below = nextStamp++
      // same URL, router state preserved: adopting never reads as navigation
      window.history.replaceState({ ...window.history.state, [stampKey]: below }, '')
      entries.set(below, { layer: false })
    }

    const layer: Layer = { stamp: nextStamp++, close: () => closeRef.current() }
    entries.set(layer.stamp, { below, layer: true })
    layers.push(layer)
    // same URL, router state preserved: the router never treats this entry as
    // a navigation of its own, and back over it rerenders nothing new
    window.history.pushState({ ...window.history.state, [stampKey]: layer.stamp }, '')

    return () => {
      layers = layers.filter((l) => l !== layer)
      consumeHere()
    }
  }, [])
}
