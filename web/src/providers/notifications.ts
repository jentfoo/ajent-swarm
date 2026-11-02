// Desktop notification bridge: while the tab is hidden and permission is
// granted, rising needs-input attention becomes one notification per item,
// never re-announced until the item settles and rises again. Returning to the
// tab dismisses everything, so the workspace is the single source.
import type { AttentionItem } from '../workspace/attention'

export type NotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

export interface NotificationBridge {
  // permission reports the current grant without prompting.
  permission(): NotificationPermission
  // ensurePermission asks the user from a click; false means refused or
  // unsupported.
  ensurePermission(): Promise<boolean>
  // publish raises notifications for new needs-input items while hidden.
  publish(items: readonly AttentionItem[]): void
  // dismissAll closes everything this bridge raised.
  dismissAll(): void
}

interface BridgeOptions {
  hidden?: () => boolean
  notify?: (title: string, body: string) => DisposableNotification
}

interface DisposableNotification {
  close(): void
}

export function createNotificationBridge(options: BridgeOptions = {}): NotificationBridge {
  const hidden = options.hidden ?? (() => document.visibilityState === 'hidden')
  const notify = options.notify ?? ((title, body) => new Notification(title, { body }))
  const announced = new Set<string>()
  const raised: DisposableNotification[] = []

  const supported = (): boolean =>
    typeof window !== 'undefined' && 'Notification' in window && Notification !== undefined

  return {
    permission(): NotificationPermission {
      if (!supported()) return 'unsupported'
      return Notification.permission as NotificationPermission
    },

    async ensurePermission(): Promise<boolean> {
      if (!supported()) return false
      if (Notification.permission === 'granted') return true
      if (Notification.permission === 'denied') return false
      try {
        return (await Notification.requestPermission()) === 'granted'
      } catch {
        return false // some engines reject outside strict user gestures
      }
    },

    publish(items) {
      if (!supported() || Notification.permission !== 'granted' || !hidden()) return
      for (const item of items) {
        if (item.kind !== 'needs-input') continue
        const key = `${item.sessionId}:${item.dialogId ?? 'd'}`
        if (announced.has(key)) continue
        announced.add(key)
        try {
          raised.push(notify(`${sessionLabel(item)} needs input`, item.reason))
        } catch {
          announced.delete(key) // construction can fail; allow a retry
        }
      }
    },

    dismissAll() {
      announced.clear()
      for (const n of raised.splice(0)) {
        try {
          n.close()
        } catch {
          // A closed notification is already gone.
        }
      }
    },
  }
}

function sessionLabel(item: AttentionItem): string {
  return item.sessionId.length <= 10 ? item.sessionId : `${item.sessionId.slice(0, 8)}…`
}
