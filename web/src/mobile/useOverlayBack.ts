import { useEffect, useRef } from 'react'

// stampKey marks the history entries this module pushes. A stamp names the
// layer that pushed its entry, so one layer's close never consumes an entry
// pushed for another.
const stampKey = 'swarmOverlay'

interface Layer {
  stamp: number
  // stamp of the entry our consume traversal lands on, captured at push
  below: number | undefined
  close: () => void
}

// Open layers, outermost last.
let layers: Layer[] = []
// stamps queued consume traversals expect to land on; a popstate matching one
// is our own step, anything else is a real back navigation
const pendingLands: (number | undefined)[] = []
let nextStamp = 1
let bound = false

// entryHere reads this module's stamp off the current history entry.
function entryHere(): number | undefined {
  const state: unknown = window.history.state
  if (typeof state !== 'object' || state === null) return undefined
  const stamp = (state as Record<string, unknown>)[stampKey]
  return typeof stamp === 'number' ? stamp : undefined
}

const onPop = () => {
  const landed = pendingLands.indexOf(entryHere())
  if (landed !== -1) {
    // our own consume stepped onto the entry it queued for; the router has
    // nothing new to show for it either
    pendingLands.splice(landed, 1)
    return
  }
  const top = layers[layers.length - 1]
  if (top !== undefined) top.close()
}

// useOverlayBack ties one overlay layer to history for as long as it is
// mounted. Opening pushes an entry beside the current one, so the platform
// back gesture and the browser back button close the topmost overlay instead
// of leaving the session, and closing through the layer's own controls (a
// drag, Escape, a Back button, a timeout) consumes that entry rather than
// leaving it behind.
//
// The two directions compose without looping: pop events close overlays, and
// overlay-initiated closes only step back over an entry this module pushed
// that no live layer still owns. A navigation the router pushed on top (a
// switcher row switching sessions) recycles or buries the entry, so closing
// then leaves history alone.
//
// Consumes are matched by landing stamp, not counted: a traversal cancelled by
// a later push (browsers and jsdom both do this) never delivers its popstate,
// so its land expectation stays behind unused, and a foreign back arriving
// meanwhile can no longer be mistaken for the consume.
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

    const layer: Layer = {
      stamp: nextStamp++,
      below: entryHere(),
      close: () => closeRef.current(),
    }
    layers.push(layer)
    // same URL, router state preserved: the router never treats this entry as
    // a navigation of its own, and back over it rerenders nothing new
    window.history.pushState({ ...window.history.state, [stampKey]: layer.stamp }, '')

    return () => {
      layers = layers.filter((l) => l !== layer)
      const stamp = entryHere()
      if (stamp === undefined) return // the router moved past this entry already
      if (layers.some((l) => l.stamp === stamp)) return // a live layer owns it
      pendingLands.push(layer.below)
      window.history.back()
    }
  }, [])
}
