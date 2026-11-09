import { useEffect, useRef } from 'react'

import { overlayOpen } from '../ui/overlayStack'

// Live digit claims, newest last. Only the topmost claim answers, mirroring
// ModalShell's open shell stack, so a second focused dock can never
// double-answer one press.
const claims: symbol[] = []

// Head-card option keys answer 1..answerDigitCount by visible position
// DialogDock's head card names each option with this same range.
export const answerDigitCount = 9
const digitKey = new RegExp(`^[1-${answerDigitCount}]$`)

// dialogDigitsClaimed reports whether a focused pane's head dialog answers
// digit keys right now, workspace digit jumps stand down while one does.
export function dialogDigitsClaimed(): boolean {
  return claims.length > 0
}

// caretInInput reports whether a press belongs to a text field: the permit
// note, the composer, any dialog answer box. Shared with workspace keys.
export function caretInInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

// useDialogAnswerKeys binds digits 1..9 to `answer` while `enabled`: the
// focused pane's head options card answers by position, one digit per option,
// the vocabulary the rail and pane strips already use for jumps. A caret in an
// input keeps its digits, an open overlay layer keeps its keys, and a press
// another listener already claimed is left alone.
export function useDialogAnswerKeys(enabled: boolean, answer: (position: number) => void): void {
  // latest answer, so the listener below never resubscribes
  const answerRef = useRef(answer)
  useEffect(() => {
    answerRef.current = answer
  })

  useEffect(() => {
    if (!enabled) return
    const claim = Symbol()
    claims.push(claim)

    const onKey = (ev: KeyboardEvent) => {
      if (claims[claims.length - 1] !== claim) return
      if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return
      if (!digitKey.test(ev.key)) return
      if (caretInInput(ev.target)) return
      if (overlayOpen()) return
      ev.preventDefault() // claims the press: workspace digits stand down
      answerRef.current(Number(ev.key))
    }

    window.addEventListener('keydown', onKey)
    return () => {
      const at = claims.indexOf(claim)
      if (at >= 0) claims.splice(at, 1)
      window.removeEventListener('keydown', onKey)
    }
  }, [enabled])
}
