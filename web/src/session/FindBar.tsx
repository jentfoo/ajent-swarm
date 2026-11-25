import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'

import { useOverlayDismiss } from '../ui/overlayStack'
import { CloseIcon } from '../ui/icons'
import type { TranscriptMatch } from './transcriptSearch'

// FindBar is the transcript's compact find surface: a query line, the active
// hit's index over the total with its flattened context, stepping and close
// controls. It rides the shared overlay stack for its lifetime, so workspace
// shortcuts and the session's own bindings stand down while it is open,
// Escape closes the topmost layer, and closing hands focus back to the
// opener. Ctrl/Cmd+F stays with the browser's own find on purpose.
export function FindBar({
  query,
  count,
  active,
  activeMatch,
  onQuery,
  onStep,
  onClose,
}: {
  query: string
  count: number
  active: number
  activeMatch: TranscriptMatch | null
  onQuery: (query: string) => void
  onStep: (delta: 1 | -1) => void
  onClose: () => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useOverlayDismiss(ref, onClose)

  // preventScroll keeps the opening press from moving the reading position
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div ref={ref} className="find-bar" role="search" aria-label="Find in transcript">
      <div className="find-row">
        <input
          ref={inputRef}
          value={query}
          placeholder="Find in committed history"
          aria-label="Find query"
          onChange={(ev) => onQuery(ev.target.value)}
          onKeyDown={(ev) => {
            // Enter steps like browser find, Shift+Enter walks back; Escape
            // stays with the overlay stack's closer
            if (ev.key !== 'Enter' || ev.nativeEvent.isComposing) return
            ev.preventDefault()
            onStep(ev.shiftKey ? -1 : 1)
          }}
        />
        {query !== '' && (
          <span className="find-count" aria-live="polite">
            {count > 0 ? `${active + 1}/${count}` : 'no matches'}
          </span>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label="Previous match"
          disabled={count === 0}
          onClick={() => onStep(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Next match"
          disabled={count === 0}
          onClick={() => onStep(1)}
        >
          ↓
        </button>
        <button type="button" className="icon-btn" aria-label="Close find" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {activeMatch !== null && (
        <p className="find-snippet">
          <span className="find-region">{activeMatch.label}</span>
          <span className="find-text">
            {activeMatch.snippet.slice(0, activeMatch.markAt)}
            <mark>{activeMatch.snippet.slice(activeMatch.markAt, activeMatch.markEnd)}</mark>
            {activeMatch.snippet.slice(activeMatch.markEnd)}
          </span>
        </p>
      )}
    </div>
  )
}
