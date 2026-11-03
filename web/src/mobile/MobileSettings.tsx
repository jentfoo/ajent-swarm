import { useState } from 'react'
import type { ReactElement } from 'react'

import { useSwarm } from '../providers/swarm'
import { SettingsMenu } from '../session/SettingsMenu'

// MobileSettings is the full-screen settings entry point: theme and density
// toggles live inside it rather than in mobile chrome, above the shared
// settings.get/settings.set menu for one of the live sessions.
export default function MobileSettings(): ReactElement {
  const { sessions, theme, setTheme, density, setDensity } = useSwarm()
  const [sessionId, setSessionId] = useState('')

  const chosen = sessionId !== '' ? sessionId : (sessions[0]?.sessionId ?? '')

  return (
    <div className="mobile-settings">
      <h2>Settings</h2>

      <section aria-label="Appearance" className="card appearance-row">
        <div className="setting-row">
          <span className="setting-label">Theme</span>
          <SegmentedToggle
            options={['dark', 'light'] as const}
            value={theme}
            onChange={(v) => setTheme(v)}
            labels={{ dark: 'Dark', light: 'Light' }}
          />
        </div>
        <div className="setting-row">
          <span className="setting-label">Density</span>
          <SegmentedToggle
            options={['cozy', 'compact'] as const}
            value={density}
            onChange={(v) => setDensity(v)}
            labels={{ cozy: 'Cozy', compact: 'Compact' }}
          />
        </div>
      </section>

      <h3>Agent settings</h3>
      {sessions.length === 0 ? (
        <p className="muted">No live sessions. Agent settings ride a session's control socket.</p>
      ) : (
        <>
          <label className="session-picker">
            Session
            <select value={chosen} onChange={(ev) => setSessionId(ev.target.value)}>
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {s.title || s.name || s.workspace || s.sessionId}
                </option>
              ))}
            </select>
          </label>
          {chosen && <SettingsMenu sessionId={chosen} />}
        </>
      )}
    </div>
  )
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
