import { useState } from 'react'
import type { ReactElement } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState, ToolState } from '../api/types'

// ToolsScreen is the pushed full-screen tools panel: snapshot rows with their
// sources, toggled through tools.set. Each toggle submits the complete desired
// set — a free replacement before the run's first prompt, enable-only after,
// where upstream keeps names left out unchanged and refusals surface as toasts.
// Toggles land as local intent so quick successive flips compose instead of
// clobbering; each records the rows it was decided against, so the next
// full-replacement tools event settles it — a confirmed toggle reads as itself
// and an externally flipped tool is never masked by stale intent. The readOnly
// flag is permission metadata, never a toggle lock; rows an already-dispatched
// run cannot release render disabled like on desktop.
export function ToolsScreen({
  sessionId,
  snap,
  open,
  onClose,
  onToast,
}: {
  sessionId: string
  snap: CtlState
  open: boolean
  onClose: () => void
  onToast: (text: string, level?: 'info' | 'error') => void
}): ReactElement | null {
  const [toggles, setToggles] = useState<Record<string, { wanted: boolean; seen: ToolState[] }>>({})

  if (!open) return null

  const streamRows = snap.tools ?? []
  // Widening only once the run dispatched a prompt; the desktop panel derives
  // this identically so both surfaces agree at every breakpoint.
  const widenOnly = snap.usage.turns > 0 || snap.running

  const enabledOf = (row: ToolState) => {
    const pending = toggles[row.name]
    return pending !== undefined && pending.seen === streamRows ? pending.wanted : row.enabled
  }

  const apply = async (row: ToolState) => {
    const wanted = !enabledOf(row)
    setToggles((prev) => {
      // drop toggles the stream already settled, then record this one
      const fresh: typeof prev = {}
      for (const [name, pending] of Object.entries(prev)) {
        if (pending.seen === streamRows) fresh[name] = pending
      }
      fresh[row.name] = { wanted, seen: streamRows }
      return fresh
    })
    try {
      await sessionAPI.setTools(
        sessionId,
        streamRows
          .map((r) => ({ name: r.name, enabled: r.name === row.name ? wanted : enabledOf(r) }))
          .filter((r) => r.enabled)
          .map((r) => r.name),
      )
      // the full-replacement tools event re-renders from the stream
    } catch (err) {
      // a refusal never reaches the stream, so drop this toggle's intent;
      // acknowledged changes settle through the tools event instead
      setToggles((prev) => {
        const pending = prev[row.name]
        if (pending === undefined || pending.seen !== streamRows || pending.wanted !== wanted) {
          return prev
        }
        const { [row.name]: _dropped, ...rest } = prev
        return rest
      })
      onToast(err instanceof ApiError ? err.message : 'Tool change refused.', 'error')
    }
  }

  return (
    <div className="pushed-screen" role="dialog" aria-label="Tools">
      <header className="pushed-header">
        <button type="button" onClick={onClose}>
          ← Back
        </button>
        <h2>Tools</h2>
      </header>
      <p className="muted tools-hint">
        Toggles apply through the session's own /tools rule: everything can be reshaped before the
        first prompt, then only enabled.
      </p>
      <div className="tool-rows">
        {streamRows.length === 0 && <p className="muted">No toggleable tools.</p>}
        {streamRows.map((row) => {
          const locked = widenOnly && row.enabled
          return (
            <label key={row.name} className={`tool-row ${locked ? 'disabled' : ''}`}>
              <input
                type="checkbox"
                checked={enabledOf(row)}
                disabled={locked}
                onChange={() => void apply(row)}
              />
              <span className="switch-name">{row.name}</span>
              <span className="muted tool-source">{row.source}</span>
            </label>
          )
        })}
      </div>
    </div>
  )
}
