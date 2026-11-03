import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

// scaleEpsilon tolerates float noise in visualViewport.scale. Anything
// beyond it reads as a page zoom rather than the default scale.
const scaleEpsilon = 0.01

// nonTextInputs are input types that never summon a software keyboard, so
// focusing them says nothing about one being open.
const nonTextInputs = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

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
    // focus moves gate which resizes mean a keyboard: the caret only exists
    // for text entry, so a blur drops the inset before the next resize lands
    window.addEventListener('focusin', update)
    window.addEventListener('focusout', update)
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      window.removeEventListener('focusin', update)
      window.removeEventListener('focusout', update)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [])

  return inset
}

// holdsCaret reports whether el is the kind of element a software keyboard
// serves: text entry, or an editable host.
function holdsCaret(el: Element | null): boolean {
  if (el === null) return false
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName === 'INPUT') return !nonTextInputs.has((el as HTMLInputElement).type)
  return (el as HTMLElement).isContentEditable
}

// currentInset measures how much shorter than the layout viewport the visual
// one is: roughly the keyboard's height while it is open. Two resizes lie:
// a pinch-zoom shrinks the visual viewport with no keyboard at all, and page
// zoom rescales every pixel of the gap, so an inset publishes only while
// page scale sits at 1 and an editable element could have summoned one.
// Negative insets clamp to zero.
function currentInset(): number {
  const vv = window.visualViewport
  if (!vv) return 0
  if (Math.abs(vv.scale - 1) > scaleEpsilon) return 0
  if (!holdsCaret(document.activeElement)) return 0
  return Math.max(0, Math.round(window.innerHeight - vv.height))
}

// keyboardInsetStyle exposes an inset as --keyboard-inset, the custom property
// theme.css reads to pad the composer column and offset fixed overlays. One
// name keeps those rules in step with what components publish.
export function keyboardInsetStyle(inset: number): CSSProperties {
  return { '--keyboard-inset': `${inset}px` } as CSSProperties
}
