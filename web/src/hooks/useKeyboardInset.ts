import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

// useKeyboardInset tracks how much of the layout viewport a software keyboard
// (or any floating browser chrome) covers, so a mobile composer can rise above
// it and the transcript stays visible while the keyboard animates. The hook
// reads window.visualViewport only; desktop browsers without one report zero.
//
// visualViewport resize events fire repeatedly during the keyboard animation;
// every value flows through state so consumers re-render with each step and
// their sticky bottoms ride along instead of jumping at the end.
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(() => currentInset())

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setInset(currentInset())
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return inset
}

// currentInset measures how much shorter than the layout viewport the visual
// one is: roughly the keyboard's height while it is open. A pinch-zoom may
// report a taller visual viewport mid-gesture; negative insets clamp to zero.
function currentInset(): number {
  const vv = window.visualViewport
  if (!vv) return 0
  return Math.max(0, Math.round(window.innerHeight - vv.height))
}

// keyboardInsetStyle exposes an inset as --keyboard-inset, the custom property
// theme.css reads to pad the composer column and offset fixed overlays. One
// name keeps those rules in step with what components publish.
export function keyboardInsetStyle(inset: number): CSSProperties {
  return { '--keyboard-inset': `${inset}px` } as CSSProperties
}
