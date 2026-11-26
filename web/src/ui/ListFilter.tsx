import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

import { useMediaQuery } from '../hooks/useMediaQuery'
import { caretInInput } from '../session/dialogKeys'
import { SearchIcon } from './icons'
import { openedWithKeyboard } from './MenuPopover'
import { overlayOpen } from './overlayStack'

// the announced count trails typing by a beat, so one burst reads as one update
const announceDebounceMs = 200

type ListFilterProps = {
  label: string // the accessible name; the placeholder never stands in for it
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean // caret on mount, skipped for a tap-opened touch menu
  resultCount?: string // polite status beside the box when set, page lists only
  hotkey?: boolean // bind '/' outside editable targets to focus this filter
}

// useDebounced reports value once it has held steady for ms, the first read
// landing immediately so a mounted count never waits.
function useDebounced(value: string, ms: number): string {
  const [steady, setSteady] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setSteady(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return steady
}

// ListFilter is the compact search input heading every operational list: a
// labeled `type="search"` box under a decorative magnifier, whose Escape
// clears the query before an open overlay layer can claim the press. Page
// lists add a debounced result-count announcement and the '/' hotkey that
// focuses the filter from anywhere outside editable targets.
export function ListFilter({
  label,
  value,
  onChange,
  autoFocus = false,
  resultCount,
  hotkey = false,
}: ListFilterProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  // the pointer class, not viewport width, tells touch apart; tests stub it
  // per render
  const touch = useMediaQuery('(pointer: coarse)')
  // the visual count is instant, only the announced text waits out a burst
  const announce = useDebounced(resultCount ?? '', announceDebounceMs)

  // a tap-opened touch menu must not grab the caret, that would summon the
  // software keyboard; a hardware-keyboard open is already deliberate
  useEffect(() => {
    if (!autoFocus || (touch && !openedWithKeyboard())) return
    inputRef.current?.focus({ preventScroll: true })
  }, [autoFocus, touch])

  // '/' routes to the page filter only from outside an editable target and
  // behind no open layer. Chords keep their browser meaning, a press another
  // listener claimed is left alone.
  useEffect(() => {
    if (!hotkey) return
    const onKey = (ev: globalThis.KeyboardEvent): void => {
      if (ev.key !== '/' || ev.defaultPrevented) return
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return // modifier chords
      if (caretInInput(ev.target)) return
      if (overlayOpen()) return
      ev.preventDefault()
      inputRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hotkey])

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
    <>
      <div className="list-filter-field">
        {/* decorative: the input's aria-label stays the accessible name */}
        <SearchIcon />
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
      </div>
      {resultCount !== undefined && (
        <span className="muted list-filter-count" role="status">
          {announce}
        </span>
      )}
    </>
  )
}
