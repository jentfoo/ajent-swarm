import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from 'react'

// armMs is how long the first click stays armed before the timer resets it.
// Long enough to survive a human confirming glance, short enough that a
// forgotten arm cannot linger.
const armMs = 10_000

// ArmedFacts is the host state an arm was granted under.
interface ArmedFacts {
  disabled: boolean
  resetKey: unknown
}

// ArmedConfirm is one armed control's handlers: onClick arms when idle and
// confirms when armed; onBlur disarms, wired to the button's own blur.
interface ArmedConfirm {
  armed: boolean
  onClick: (ev?: ReactMouseEvent<HTMLElement>) => void
  onBlur: (ev?: ReactFocusEvent<HTMLElement>) => void
}

export interface ArmedConfirmOptions {
  disabled?: boolean // the button's disabled state; a transition disarms
  resetKey?: unknown // fresh host facts disarm, keyed by caller-chosen identity
}

// inViewport reports whether the armed control still shows. An arm voids only
// on scrolls that carry it out of view, never on wheel drift, momentum tails
// or unrelated scrollers.
function inViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect()
  return (
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  )
}

// useArmedConfirm is the two-step guard for destructive buttons: the first
// click arms, a second within the window confirms, and the timer, a focus move
// onto another control or a change to the host facts disarms. A scroll voids
// the arm only once it carries the armed control out of the viewport, and
// losing document focus (alt-tab, another monitor) keeps the arm, so incidental
// activity between the presses never eats the confirm. No modal: the button
// itself carries the question.
export function useArmedConfirm(
  onConfirm: () => void,
  { disabled = false, resetKey }: ArmedConfirmOptions = {},
): ArmedConfirm {
  // null is disarmed; the arm only holds while its exact facts still do, so a
  // poll re-render or a disabled transition voids it without a reset effect
  const [armedFacts, setArmedFacts] = useState<ArmedFacts | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // the control the arm was granted on, for the out-of-view check
  const armedEl = useRef<HTMLElement | null>(null)

  const armed =
    armedFacts !== null && armedFacts.disabled === disabled && armedFacts.resetKey === resetKey

  const disarm = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    armedEl.current = null
    setArmedFacts(null)
  }, [])

  useEffect(() => disarm, [disarm])

  // scroll does not bubble, but capture still sees every scroller's event; the
  // arm survives unless the scrolling carried the armed control out of view
  useEffect(() => {
    if (!armed) return
    const onScroll = () => {
      const el = armedEl.current
      if (el === null || (el.isConnected && inViewport(el))) return
      disarm()
    }
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => document.removeEventListener('scroll', onScroll, { capture: true })
  }, [armed, disarm])

  const onClick = useCallback(
    (ev?: ReactMouseEvent<HTMLElement>) => {
      if (disabled) return
      if (armed) {
        disarm()
        onConfirm()
        return
      }
      if (timer.current !== null) clearTimeout(timer.current)
      armedEl.current = ev?.currentTarget ?? null
      setArmedFacts({ disabled, resetKey })
      timer.current = setTimeout(() => {
        timer.current = null
        disarm()
      }, armMs)
    },
    [armed, disabled, resetKey, disarm, onConfirm],
  )

  const onBlur = useCallback(
    (ev?: ReactFocusEvent<HTMLElement>) => {
      // focus with nowhere in-document to land (alt-tab, a click on plain page
      // area, focus-follows-mouse crossing windows) is not a changed mind;
      // only a move onto another control voids the arm
      if (ev && ev.relatedTarget === null) return
      disarm()
    },
    [disarm],
  )

  return { armed, onClick, onBlur }
}
