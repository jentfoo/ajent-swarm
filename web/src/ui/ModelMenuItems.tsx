import type { ReactElement } from 'react'

import type { ModelState } from '../api/types'
import { providerGroups } from './modelGroups'

// itemTitle is one row's tooltip: the full key plus the token window when known.
function itemTitle(m: ModelState): string {
  return m.key + (m.window > 0 ? ` · ${m.window.toLocaleString()} token window` : '')
}

// ModelMenuItems renders a models.get listing as a grouped menu body: a muted
// provider heading before each group's `short || key` buttons, loose models by
// full key, the current badge on the listing's active or the snapshot's key,
// and the empty message when nothing lists. The desktop header menu and the
// mobile chip both render through this, so the two chat surfaces read
// identically on the one grouping rule.
export function ModelMenuItems({
  models,
  active,
  currentKey,
  onPick,
}: {
  models: ModelState[]
  active: string // the listing's active key
  currentKey: string // the snapshot's model key
  onPick: (key: string) => void
}): ReactElement {
  if (models.length === 0) {
    return <span className="muted menu-empty">No models listed.</span>
  }
  const badge = (key: string): ReactElement | null =>
    key === active || key === currentKey ? <span className="badge ok">current</span> : null
  const { groups, loose } = providerGroups(models)
  return (
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
  )
}
