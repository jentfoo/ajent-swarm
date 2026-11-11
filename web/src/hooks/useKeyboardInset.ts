import { useEffect, useState } from 'react'

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
// reads window.visualViewport only, desktop browsers without one report zero.
//
// visualViewport resize events fire repeatedly during the keyboard animation.
// Every value flows through state so consumers re-render with each step and
// their sticky bottoms ride along instead of jumping at the end.
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(() => currentInset())

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setInset(currentInset())
    // WebKit's keyboard reveal pans the document itself when no inner scroller
    // can absorb the shift (bug 191204): with a keyboard open the layout
    // viewport scrolls by up to the keyboard height even though nothing
    // overflows, dragging the shell and its sticky header along. The composer
    // already rides --keyboard-inset, so while text entry holds the caret the
    // window pins at scrollTop zero and the inset stays the one positioning
    // force. Pinning on focusin also un-pans a view stuck from an earlier pass.
    const pinPan = () => {
      if (!holdsCaret(document.activeElement)) return
      // only a downward reveal pan counts; the upward rubber band stays free
      if (window.scrollY > 0) window.scrollTo(0, 0)
    }
    const onViewportEvent = () => {
      update()
      pinPan()
    }
    // focus moves gate which resizes mean a keyboard: the caret only exists
    // for text entry, so a blur drops the inset before the next resize lands
    window.addEventListener('focusin', onViewportEvent)
    window.addEventListener('focusout', update)
    window.addEventListener('scroll', pinPan)
    vv.addEventListener('resize', onViewportEvent)
    vv.addEventListener('scroll', onViewportEvent)
    return () => {
      window.removeEventListener('focusin', onViewportEvent)
      window.removeEventListener('focusout', update)
      window.removeEventListener('scroll', pinPan)
      vv.removeEventListener('resize', onViewportEvent)
      vv.removeEventListener('scroll', onViewportEvent)
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
