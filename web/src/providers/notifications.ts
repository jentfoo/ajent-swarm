// Notification bridge stub: phase 09 replaces this with real desktop
// notifications while the tab is hidden. The provider hands every attention
// digest to the bridge, so later phases swap the implementation without
// touching polling or state.
import type { AttentionRow } from '../api/types'

export interface NotificationBridge {
  publish(attention: readonly AttentionRow[]): void
}

export function noopBridge(): NotificationBridge {
  return { publish() {} }
}
