import { useCallback, useEffect, useRef, useState } from 'react'

// armMs is how long the first click stays armed before the timer resets it.
const armMs = 4_000

// ArmedFacts is the host state an arm was granted under.
interface ArmedFacts {
  disabled: boolean
  resetKey: unknown
}

export interface ArmedConfirm {
  armed: boolean
  onClick: () => void // arms when idle, confirms when armed
  onBlur: () => void // disarms; wire to the button's own blur
}

export interface ArmedConfirmOptions {
  disabled?: boolean // the button's disabled state; a transition disarms
  resetKey?: unknown // fresh host data disarms, e.g. a poll-rebuilt row object
}

// useArmedConfirm is the two-step guard for destructive buttons: the first
// click arms, a second within the window confirms, and the timer, blur, any
// scroll or a change to the host facts disarms. No modal: the button itself
// carries the question.
export function useArmedConfirm(
  onConfirm: () => void,
  { disabled = false, resetKey }: ArmedConfirmOptions = {},
): ArmedConfirm {
  // null is disarmed; the arm only holds while its exact facts still do, so a
  // poll re-render or a disabled transition voids it without a reset effect
  const [armedFacts, setArmedFacts] = useState<ArmedFacts | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const armed =
    armedFacts !== null && armedFacts.disabled === disabled && armedFacts.resetKey === resetKey

  const disarm = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    setArmedFacts(null)
  }, [])

  useEffect(() => disarm, [disarm])

  // scroll does not bubble, but capture still sees every scroller's event; a
  // viewport that moved under the user voids the pending confirm
  useEffect(() => {
    if (!armed) return
    document.addEventListener('scroll', disarm, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', disarm, { capture: true })
  }, [armed, disarm])

  const onClick = useCallback(() => {
    if (disabled) return
    if (armed) {
      disarm()
      onConfirm()
      return
    }
    if (timer.current !== null) clearTimeout(timer.current)
    setArmedFacts({ disabled, resetKey })
    timer.current = setTimeout(() => {
      timer.current = null
      disarm()
    }, armMs)
  }, [armed, disabled, resetKey, disarm, onConfirm])

  const onBlur = useCallback(() => disarm(), [disarm])

  return { armed, onClick, onBlur }
}
