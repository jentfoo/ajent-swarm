import type { ReactElement } from 'react'

import { useAuth } from '../providers/auth'
import type { NotificationPermission } from '../providers/notifications'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'
import { TitleModelSelect } from '../shell/TitleModelSelect'

// MobileSettings is the full-screen global settings entry point: theme lives
// inside it rather than in mobile chrome, beside swarm's own settings and the
// notification permission. The per-session agent settings live on each session
// screen, so there is no session picker here.
export default function MobileSettings(): ReactElement {
  const { theme, setTheme } = useSwarm()
  const { username, logout } = useAuth()

  return (
    <div className="mobile-settings">
      <h2>Settings</h2>

      <section aria-label="Appearance" className="card settings-card">
        <div className="setting-row">
          <span className="setting-label">Theme</span>
          <SegmentedToggle
            options={['dark', 'light'] as const}
            value={theme}
            onChange={(v) => setTheme(v)}
            labels={{ dark: 'Dark', light: 'Light' }}
          />
        </div>
      </section>

      <section aria-label="Notifications" className="card settings-card">
        <NotificationRow />
      </section>

      <h3>Global</h3>
      <section aria-label="Global settings" className="card">
        <TitleModelSelect />
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
          Per-session agent settings live in each session's ☰ header.
        </p>
      </section>

      <h3>Account</h3>
      <section aria-label="Account" className="card">
        <div className="setting-row">
          <span className="account-name">{username}</span>
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  )
}

// NotificationRow reports the current permission and keeps a manual enable
// path beside it, independent of the contextual prompt. Denied permission can
// only lift through the browser's own site settings.
function NotificationRow(): ReactElement {
  const { notificationPermission: permission, requestNotifications } = useWorkspace()
  return (
    <div className="setting-row">
      <span className="setting-label">Notifications</span>
      {permission === 'default' ? (
        <>
          <span className="muted">Off</span>
          <button type="button" onClick={() => requestNotifications()}>
            Enable
          </button>
        </>
      ) : (
        <span>{permissionStatus[permission]}</span>
      )}
    </div>
  )
}

// Status text for the settled permissions; the undecided state is not a status
// at all, it carries the enable action instead.
const permissionStatus: Record<Exclude<NotificationPermission, 'default'>, string> = {
  granted: 'On',
  denied: 'Blocked in browser settings',
  unsupported: 'Not available here',
}

// SegmentedToggle is a two-option inline switch sized for thumbs.
function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  labels: Record<T, string>
}): ReactElement {
  return (
    <span className="segmented" role="group">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          className={value === opt ? 'active' : ''}
          onClick={() => onChange(opt)}
        >
          {labels[opt]}
        </button>
      ))}
    </span>
  )
}
