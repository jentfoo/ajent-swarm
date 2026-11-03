import type { ReactElement } from 'react'

import { useSwarm } from '../providers/swarm'
import { TitleModelSelect } from '../shell/TitleModelSelect'

// MobileSettings is the full-screen global settings entry point: theme lives
// inside it rather than in mobile chrome, beside swarm's own settings. The
// per-session agent settings live on each session screen, so there is no
// session picker here.
export default function MobileSettings(): ReactElement {
  const { theme, setTheme } = useSwarm()

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
      </section>

      <h3>Global</h3>
      <section aria-label="Global settings" className="card">
        <TitleModelSelect />
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
          Per-session agent settings live in each session's ☰ header.
        </p>
      </section>
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
