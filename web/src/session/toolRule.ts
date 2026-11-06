import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState } from '../api/types'

// ToolChoice names one tool's desired state in an apply; rows carry more
// metadata but only these two fields reach the wire.
export interface ToolChoice {
  name: string
  enabled: boolean
}

// toolsWidenOnly is the one widen-only derivation every tool surface reads.
// Before the run's first dispatched prompt any reshaping goes; afterwards a
// toggle may just enable. Turns started plus completed approximates "the model
// has seen a tool block", and a running turn always has.
export function toolsWidenOnly(snap: CtlState): boolean {
  return snap.usage.turns > 0 || snap.running
}

// applyToolSet posts one complete desired set through tools.set; a refusal
// surfaces as a toast. True when the request landed — the full-replacement
// tools event re-renders rows from the stream, so callers never apply the
// reply themselves.
export async function applyToolSet(
  sessionId: string,
  desired: readonly ToolChoice[],
  onToast: (text: string, level?: 'info' | 'error') => void,
): Promise<boolean> {
  try {
    await sessionAPI.setTools(
      sessionId,
      desired.filter((r) => r.enabled).map((r) => r.name),
    )
    return true
  } catch (err) {
    onToast(err instanceof ApiError ? err.message : 'Tool change refused.', 'error')
    return false
  }
}
