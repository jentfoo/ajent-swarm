import { useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

import { useMediaQuery } from '../hooks/useMediaQuery'
import { openedWithKeyboard } from './MenuPopover'

type ListFilterProps = {
  label: string // the accessible name; the placeholder never stands in for it
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean // caret on mount, skipped for a tap-opened touch menu
}

// ListFilter is the compact search input heading every operational list: a
// labeled `type="search"` box whose Escape clears the query before an open
// overlay layer can claim the press for closing itself.
export function ListFilter({
  label,
  value,
  onChange,
  autoFocus = false,
}: ListFilterProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  // the pointer class, not viewport width, tells touch apart; tests stub it
  // per render
  const touch = useMediaQuery('(pointer: coarse)')

  // a tap-opened touch menu must not grab the caret, that would summon the
  // software keyboard; a hardware-keyboard open is already deliberate
  useEffect(() => {
    if (!autoFocus || (touch && !openedWithKeyboard())) return
    inputRef.current?.focus({ preventScroll: true })
  }, [autoFocus, touch])

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key !== 'Escape' || ev.ctrlKey || ev.metaKey || ev.altKey) return
    if (ev.nativeEvent.isComposing) return // a mid-composition IME keeps its keys
    if (value.trim() === '') return // the press falls through and closes the layer
    // claimed before the popover's document listener runs, so the first Escape
    // clears the filter and only the next one closes
    ev.preventDefault()
    onChange('')
  }

  return (
    <input
      ref={inputRef}
      type="search"
      value={value}
      placeholder={label}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      onChange={(ev) => onChange(ev.target.value)}
      onKeyDown={onKeyDown}
    />
  )
}
