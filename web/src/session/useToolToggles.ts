import { useRef, useState } from 'react'

import type { ToolState } from '../api/types'
import { applyToolSet } from './toolRule'

// ToolIntent is one pending toggle: the wanted state plus the streamed rows it
// was decided against. Rows ride by identity, so the next full-replacement
// tools event (a fresh rows array) settles every intent at once.
interface ToolIntent {
  wanted: boolean
  seen: readonly ToolState[]
}

export interface ToolToggles {
  // enabledOf reads one row's effective state: the streamed fact overlaid with
  // any pending intent still decided against the rows of this render.
  enabledOf: (row: ToolState) => boolean
  // toggle flips one row and posts the complete desired set with every pending
  // intent composed in. Refusals toast and snap the row back.
  toggle: (row: ToolState) => void
}

// useToolToggles is the toggle intent machine every tools surface shares:
// each flip lands as intent keyed by the streamed rows it was decided against,
// so quick successive flips compose instead of clobbering and the next tools
// event settles them — a confirmed toggle reads as itself, an external flip is
// never masked by stale intent. A refusal never reaches the stream, so it
// drops its own intent and the row snaps back.
export function useToolToggles(
  sessionId: string,
  rows: readonly ToolState[],
  onToast: (text: string, level?: 'info' | 'error') => void,
): ToolToggles {
  // the ref is the truth same-tick toggles compose on; commit mirrors it
  // into state just to re-render
  const [, setToggles] = useState<Record<string, ToolIntent>>({})
  const ref = useRef<Record<string, ToolIntent>>({})
  const commit = (next: Record<string, ToolIntent>) => {
    ref.current = next
    setToggles(next)
  }

  const enabledOf = (row: ToolState): boolean => {
    const pending = ref.current[row.name]
    return pending !== undefined && pending.seen === rows ? pending.wanted : row.enabled
  }

  const toggle = (row: ToolState): void => {
    const wanted = !enabledOf(row)
    // drop intents the stream already settled, then record this one
    const fresh: Record<string, ToolIntent> = {}
    for (const [name, pending] of Object.entries(ref.current)) {
      if (pending.seen === rows) fresh[name] = pending
    }
    fresh[row.name] = { wanted, seen: rows }
    commit(fresh)

    void applyToolSet(
      sessionId,
      rows.map((r) => ({ name: r.name, enabled: r.name === row.name ? wanted : enabledOf(r) })),
      onToast,
    ).then((landed) => {
      if (landed) return
      // a refusal never reaches the stream, so drop this intent unless a
      // newer toggle superseded it
      const pending = ref.current[row.name]
      if (pending === undefined || pending.seen !== rows || pending.wanted !== wanted) return
      const { [row.name]: _dropped, ...rest } = ref.current
      commit(rest)
    })
  }

  return { enabledOf, toggle }
}
