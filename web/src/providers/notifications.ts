// Desktop notification bridge: while the tab is hidden and permission is
// granted, rising needs-input attention becomes one notification per item,
// never re-announced until the item settles and rises again. A settled dialog
// closes its notification on the next digest, so the tray only holds live
// wants, and returning to the tab dismisses everything anyway: the workspace
// is the single source.
import type { AttentionItem } from '../workspace/attention'

export type NotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

// One raised notification; close withdraws it from the tray.
interface DisposableNotification {
  close(): void
}

// What the bridge wants raised: title and body carry the attention facts, tag
// keys one tray slot per session so different sessions never merge, and
// onclick activates the session.
export interface NotificationRequest {
  title: string
  body: string
  tag: string
  onclick: () => void
}

// What the host resolves at raise time: display names through the shared
// namer, and the click-through that focuses the app on that session.
export interface BridgeHost {
  nameFor: (sessionId: string) => string
  openSession: (sessionId: string) => void
}

export interface NotificationBridge {
  // permission reports the current grant without prompting.
  permission(): NotificationPermission
  // ensurePermission asks the user from a click; false means refused or
  // unsupported.
  ensurePermission(): Promise<boolean>
  // publish raises notifications for new needs-input items while hidden and
  // closes the ones whose dialog has settled.
  publish(items: readonly AttentionItem[], host: BridgeHost): void
  // dismissAll closes everything this bridge raised.
  dismissAll(): void
}

interface BridgeOptions {
  hidden?: () => boolean
  notify?: (req: NotificationRequest) => DisposableNotification
}

// announceKey identities one rising item: a session's next dialog rises fresh,
// while the tag keeps the session to one tray slot.
function announceKey(item: AttentionItem): string {
  return `${item.sessionId}:${item.dialogId ?? 'd'}`
}

function defaultNotify(req: NotificationRequest): DisposableNotification {
  const n = new Notification(req.title, { body: req.body, tag: req.tag })
  n.onclick = () => {
    req.onclick()
    n.close()
  }
  return n
}

export function createNotificationBridge(options: BridgeOptions = {}): NotificationBridge {
  const hidden = options.hidden ?? (() => document.visibilityState === 'hidden')
  const notify = options.notify ?? defaultNotify
  // Raised notifications keyed by announce key; a present key marks its item
  // announced, so it stays one notification per item until it settles.
  const raised = new Map<string, DisposableNotification>()

  const supported = (): boolean => 'Notification' in window && Notification !== undefined

  const closeQuietly = (n: DisposableNotification): void => {
    try {
      n.close()
    } catch {
      // A closed notification is already gone.
    }
  }

  // A raised item that left the needs-input set has settled: close its
  // notification now rather than waiting for the tab to become visible.
  const closeSettled = (items: readonly AttentionItem[]): void => {
    const live = new Set(items.filter((i) => i.kind === 'needs-input').map((i) => announceKey(i)))
    for (const [key, n] of raised) {
      if (live.has(key)) continue
      closeQuietly(n)
      raised.delete(key)
    }
  }

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

    publish(items, host) {
      if (!supported() || Notification.permission !== 'granted' || !hidden()) return
      closeSettled(items)
      for (const item of items) {
        if (item.kind !== 'needs-input') continue
        const key = announceKey(item)
        if (raised.has(key)) continue
        try {
          raised.set(
            key,
            notify({
              title: `${host.nameFor(item.sessionId)} needs input`,
              body: item.reason,
              tag: item.sessionId,
              onclick: () => host.openSession(item.sessionId),
            }),
          )
        } catch {
          // construction can fail; the unset key lets a later digest retry
        }
      }
    },

    dismissAll() {
      for (const n of raised.values()) closeQuietly(n)
      raised.clear()
    },
  }
}
