import type { MouseEvent, RefObject } from 'react'

// touchKeyboard marks a touch-primary device, read once at module scope so key
// and press handling never re-evaluate it: a virtual keyboard has no Shift, so
// Enter means newline, and submit presses keep the keyboard open.
export const touchKeyboard = window.matchMedia('(pointer: coarse)').matches

// handlers spreads over the submit button element.
interface PressHandlers {
  onMouseDown?: (ev: MouseEvent<HTMLButtonElement>) => void
  onClick?: (ev: MouseEvent<HTMLButtonElement>) => void
}

// SubmitPress carries one submit-beside-text button's touch policy:
// keyboardDismiss marks the empty-draft press that closes the keyboard (the
// site gives it the disabled look), disabled holds the host's real disabled
// state, and handlers spreads over the button element.
interface SubmitPress {
  keyboardDismiss: boolean
  disabled: boolean
  handlers: PressHandlers
}

// useSubmitPress owns a submit-beside-text button's press on touch: the
// press's default focus move is what dismisses the virtual keyboard and
// resizes the layout under the finger, so the browser drops the tap's click on
// a moving target. Suppressed, one tap submits with the keyboard staying open,
// and an empty draft trades the submit for the keyboard's dismissal. Pass the
// input holding the draft, whether the draft is empty, and the host's own
// disabled state, fine pointers keep the default press.
export function useSubmitPress(
  input: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  empty: boolean,
  hostDisabled: boolean,
): SubmitPress {
  if (!touchKeyboard)
    return { keyboardDismiss: false, disabled: hostDisabled || empty, handlers: {} }
  const keyboardDismiss = !hostDisabled && empty
  const handlers: PressHandlers = {
    onMouseDown: (ev) => ev.preventDefault(), // the input keeps its focus
  }
  if (keyboardDismiss)
    handlers.onClick = (ev) => {
      ev.preventDefault() // an empty draft never submits
      input.current?.blur() // the blur is the keyboard's dismissal
    }
  return { keyboardDismiss, disabled: hostDisabled, handlers }
}
