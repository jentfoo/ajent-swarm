import type { ReactElement } from 'react'

import type { ModelState } from '../api/types'
import { filterModelGroups } from './modelFilter'

// itemTitle is one row's tooltip: the full key plus the token window when known.
function itemTitle(m: ModelState): string {
  return m.key + (m.window > 0 ? ` · ${m.window.toLocaleString()} token window` : '')
}

type ModelMenuProps = {
  models: ModelState[]
  query: string // the header filter's text, narrowing the rows live
  active: string // the listing's active key
  currentKey: string // the snapshot's model key
  onPick: (key: string) => void
}

// ModelMenuItems renders a models.get listing as a grouped menu body: a muted
// provider heading before each group's `short || key` rows, loose models by
// full key, the current badge on the listing's active or the snapshot's key,
// and the empty messages when nothing lists or matches the query. Rows are
// menu item radios: one model is active at a time, so the current one carries
// aria-checked beside the badge. The desktop header menu and the mobile chip
// both render this body under the same filter row, so the two chat surfaces
// read identically on the one grouping and matching rules.
export function ModelMenuItems({
  models,
  query,
  active,
  currentKey,
  onPick,
}: ModelMenuProps): ReactElement {
  if (models.length === 0) {
    return <span className="muted menu-empty">No models listed.</span>
  }
  // the listing's active key or the snapshot's model marks the menu's current
  // item, both for the badge and keyboard-open focus
  const isCurrent = (key: string): boolean => key === active || key === currentKey

  const { groups, loose } = filterModelGroups(query, models)
  // a blank query keeps every listed row, so an empty answer is a filter miss
  if (groups.length === 0 && loose.length === 0) {
    return <span className="muted menu-empty">No models match.</span>
  }

  const row = (m: ModelState): ReactElement => {
    const current = isCurrent(m.key)
    return (
      <button
        key={m.key}
        type="button"
        role="menuitemradio"
        aria-checked={current}
        title={itemTitle(m)}
        onClick={() => onPick(m.key)}
      >
        {m.short || m.key}
        {current && <span className="badge ok">current</span>}
      </button>
    )
  }
  return (
    <>
      {groups.map((g) => (
        <div key={g.provider} role="group" aria-label={g.provider} className="model-menu-group">
          <span className="menu-heading">{g.provider}</span>
          {g.models.map(row)}
        </div>
      ))}
      {loose.map(row)}
    </>
  )
}
