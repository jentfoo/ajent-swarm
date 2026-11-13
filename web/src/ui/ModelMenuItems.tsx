import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

import type { ModelState } from '../api/types'
import { filterModelGroups } from './modelFilter'

// itemTitle is one row's tooltip: the full key plus the token window when known.
function itemTitle(m: ModelState): string {
  return m.key + (m.window > 0 ? ` · ${m.window.toLocaleString()} token window` : '')
}

type ModelMenuProps = {
  models: ModelState[]
  active: string // the listing's active key
  currentKey: string // the snapshot's model key
  onPick: (key: string) => void
}

// ModelMenuItems renders a models.get listing as a grouped menu body: a filter
// input above the tree narrowing it live, a muted provider heading before each
// group's `short || key` buttons, loose models by full key, the current badge
// on the listing's active or the snapshot's key, and the empty message when
// nothing lists. The desktop header menu and the mobile chip both render
// through this, so the two chat surfaces read identically on the one grouping
// and matching rules.
export function ModelMenuItems({ models, ...rest }: ModelMenuProps): ReactElement {
  if (models.length === 0) {
    return <span className="muted menu-empty">No models listed.</span>
  }
  // a distinct body drops the query with the listing, so a refill starts blank
  return <ModelMenuTree models={models} {...rest} />
}

function ModelMenuTree({ models, active, currentKey, onPick }: ModelMenuProps): ReactElement {
  const [query, setQuery] = useState('')
  const filterRef = useRef<HTMLInputElement>(null)

  // the caret lands in the filter without scrolling: MenuPopover places its
  // layer only after a measure, so a plain focus would scroll to the unplaced
  // menu's flow position instead
  useEffect(() => {
    filterRef.current?.focus({ preventScroll: true })
  }, [])

  const onFilterKey = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key !== 'Escape' || ev.ctrlKey || ev.metaKey || ev.altKey) return
    if (ev.nativeEvent.isComposing) return // a mid-composition IME keeps its keys
    if (query.trim() === '') return // the press falls through and closes the layer
    // claimed before the popover's document listener runs, so the first Escape
    // clears the filter and only the next one closes
    ev.preventDefault()
    setQuery('')
  }

  const { groups, loose } = filterModelGroups(query, models)
  // a blank query keeps every listed row, so an empty answer is a filter miss
  const noneMatch = groups.length === 0 && loose.length === 0

  const badge = (key: string): ReactElement | null =>
    key === active || key === currentKey ? <span className="badge ok">current</span> : null
  return (
    <>
      <div className="menu-filter-row">
        <input
          ref={filterRef}
          type="search"
          value={query}
          placeholder="Filter models"
          aria-label="Filter models"
          autoComplete="off"
          spellCheck={false}
          onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={onFilterKey}
        />
      </div>
      {noneMatch ? (
        <span className="muted menu-empty">No models match.</span>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.provider} role="group" aria-label={g.provider} className="model-menu-group">
              <span className="menu-heading">{g.provider}</span>
              {g.models.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="menuitem"
                  title={itemTitle(m)}
                  onClick={() => onPick(m.key)}
                >
                  {m.short || m.key}
                  {badge(m.key)}
                </button>
              ))}
            </div>
          ))}
          {loose.map((m) => (
            <button
              key={m.key}
              type="button"
              role="menuitem"
              title={itemTitle(m)}
              onClick={() => onPick(m.key)}
            >
              {m.key}
              {badge(m.key)}
            </button>
          ))}
        </>
      )}
    </>
  )
}
