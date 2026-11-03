import { useState } from 'react'
import type { ReactElement } from 'react'

import { useWorkspace } from '../providers/workspace'
import { dismissNotificationPrompt, notificationsPromptDue } from '../providers/notificationPrompt'

// NotificationPrompt is mobile's contextual notification opt-in: while a
// session needs input and permission is still undecided, one small affordance
// offers to enable them, so the tap shares the gesture context of the alert
// that prompted it. Visibility derives straight from attention, permission and
// the anti-nag state; MobileShell keeps this mounted for the page's lifetime,
// so a refusal mutes the rest of the visit on its own.
export default function NotificationPrompt(): ReactElement | null {
  const {
    needsInputCount,
    notificationPermission: permission,
    requestNotifications,
  } = useWorkspace()
  const [dismissed, setDismissed] = useState(() => !notificationsPromptDue(permission))

  if (permission !== 'default' || needsInputCount === 0 || dismissed) return null

  return (
    <section className="notify-prompt card" aria-label="Enable notifications">
      <p className="notify-copy">Get notified when a session needs input.</p>
      <div className="notify-actions">
        <button type="button" className="primary" onClick={() => requestNotifications()}>
          Enable notifications
        </button>
        <button
          type="button"
          onClick={() => {
            dismissNotificationPrompt()
            setDismissed(true)
          }}
        >
          Not now
        </button>
      </div>
    </section>
  )
}
