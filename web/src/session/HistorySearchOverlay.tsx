import { useEffect, useRef } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { matchSpans, previewLine, type HistorySearch } from './historySearch'
import { CloseIcon } from '../ui/icons'

// HistorySearchOverlay is the reverse search surface above the composer: a
// query echo header over the matching prompts, blank until text is typed and
// showing a "no match" note otherwise. Each row previews a window around its
// match, so long prompts stay scannable. Hosted by Composer through
// MenuPopover like the @-menu, so pane clipping cannot cut it off; never a
// modal picker: the composer keeps focus and feeds the keys, and a row click
// (or tap) accepts that row into the draft.
export function HistorySearchOverlay({
  search,
  onHighlight,
  onAccept,
  onClose,
}: {
  search: HistorySearch
  onHighlight: (delta: number) => void
  onAccept: (text: string) => void
  onClose: () => void
}): ReactElement {
  // Stepping must keep the highlighted row visible in the scrollable list,
  // the way the TUI's single-match row always shows the current hit.
  const activeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [search])

  return (
    <div className="search-menu" aria-label="Prompt history search">
      <div className="search-header">
        <span className="search-echo" aria-live="polite">
          (reverse-i-search)`{search.query}':
          {search.matches.length > 0 && (
            <span className="search-count">
              {' '}
              {search.cursor + 1}/{search.matches.length}
            </span>
          )}
        </span>
        <button
          type="button"
          className="search-close icon-btn"
          aria-label="Close history search"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      {search.query !== '' && search.matches.length === 0 && (
        <p className="search-empty">no match</p>
      )}
      {search.matches.length > 0 && (
        <ul className="search-list" role="listbox" aria-label="Matching prompts">
          {/* the composer's one activation path: the prevented pointerdown
              keeps the caret, click accepts exactly once (Composer.tsx) */}
          {search.matches.map((text, i) => (
            <li key={text}>
              <button
                type="button"
                ref={i === search.cursor ? activeRef : undefined}
                role="option"
                aria-selected={i === search.cursor}
                className={i === search.cursor ? 'active' : ''}
                title={text}
                onPointerDown={(ev) => ev.preventDefault()}
                onClick={() => onAccept(text)}
                onMouseEnter={() => onHighlight(i - search.cursor)}
              >
                <PreviewRow text={text} query={search.query} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// PreviewRow shows one candidate through a window around the match, so a
// long prompt reads by its hit instead of its opening lines, with the count
// of lines the window hides.
function PreviewRow({ text, query }: { text: string; query: string }): ReactElement {
  const preview = previewLine(text, query)
  return (
    <>
      <HighlightRow text={preview.text} query={query} />
      {preview.extraLines > 0 && <span className="search-extra">+{preview.extraLines} lines</span>}
    </>
  )
}

// HighlightRow renders one candidate with every query occurrence emphasized,
// so caret and emphasis agree on which occurrence "the match" is.
function HighlightRow({ text, query }: { text: string; query: string }): ReactElement {
  const spans = matchSpans(text, query)
  if (spans.length === 0) return <span className="search-row">{text}</span>
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of spans) {
    if (at < start) parts.push(text.slice(at, start))
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>)
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <span className="search-row">{parts}</span>
}
