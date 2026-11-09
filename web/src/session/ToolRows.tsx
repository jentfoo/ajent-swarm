import type { ReactElement } from 'react'

import type { CtlState } from '../api/types'
import { toolsWidenOnly } from './toolRule'
import { useToolToggles } from './useToolToggles'

// lockedTitle is the per-row lock reason hover surfaces carry, touch surfaces
// state the same rule once in a hint paragraph above the rows.
const lockedTitle = 'Widen-only after the first prompt: this toggle can only enable'

// ToolRows renders one checkbox row per streamed tool through tools.set's
// shared intent machine (useToolToggles), so quick flips compose instead of
// clobbering while the stream lags. After the run's first dispatched prompt
// the apply rule is widen-only (toolRule.ts): toggles that would disable render
// disabled with their reason instead of refusing as a surprise. The readOnly
// flag is permission metadata, every registered tool stays toggleable here,
// matching upstream's own picker.
//
// lockTooltips names each locked checkbox for hover surfaces, touch explains
// the rule once in its own hint paragraph and keeps the rows unlabeled.
export function ToolRows({
  sessionId,
  snap,
  onToast,
  lockTooltips = false,
}: {
  sessionId: string
  snap: CtlState
  onToast: (text: string, level?: 'info' | 'error') => void
  lockTooltips?: boolean
}): ReactElement {
  const rows = snap.tools ?? []
  const widenOnly = toolsWidenOnly(snap)
  const { enabledOf, toggle } = useToolToggles(sessionId, rows, onToast)

  return (
    <>
      {rows.map((row) => {
        const locked = widenOnly && row.enabled
        return (
          <label key={row.name} className={`tool-row ${locked ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={enabledOf(row)}
              disabled={locked}
              title={lockTooltips && locked ? lockedTitle : undefined}
              onChange={() => toggle(row)}
            />
            <span className="switch-name">{row.name}</span>
            <span className="muted tool-source">{row.source}</span>
          </label>
        )
      })}
    </>
  )
}
