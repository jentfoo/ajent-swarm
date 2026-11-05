import type { ReactElement } from 'react'

import type { ModelState } from '../api/types'
import { providerGroups } from './modelGroups'

// ModelSelectOptions renders a registry as a select's option body: one
// optgroup per provider with short labels, loose models ungrouped by full
// key. Every model select renders through this, so each reads like the chat
// model button's grouped menu; call sites keep their own special options
// (defaults, missing-value fallbacks) around it.
export function ModelSelectOptions({ models }: { models: ModelState[] }): ReactElement {
  const { groups, loose } = providerGroups(models)
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.provider} label={g.provider}>
          {g.models.map((m) => (
            <option key={m.key} value={m.key}>
              {m.short || m.key}
            </option>
          ))}
        </optgroup>
      ))}
      {/* no provider prefix: render the full key ungrouped */}
      {loose.map((m) => (
        <option key={m.key} value={m.key}>
          {m.key}
        </option>
      ))}
    </>
  )
}
