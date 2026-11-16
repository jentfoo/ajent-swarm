import type { ReactElement } from 'react'

import { HamburgerDialog } from '../session/AgentSettingsMenu'
import { TitleModelSelect } from './TitleModelSelect'

// GlobalSettingsMenu is the top-bar ☰: swarm's own settings, which need no
// session behind them. Per-session agent settings moved into the chat header
// and session cards, where the session they edit is the one on screen.
export function GlobalSettingsMenu(): ReactElement {
  return (
    <HamburgerDialog label="Global settings">
      <h3 style={{ margin: '0 0 calc(var(--unit) * 2)', fontSize: 'inherit' }}>Global settings</h3>
      <TitleModelSelect />
      <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-small)' }}>
        Per-session agent settings live in each chat's ☰ header.
      </p>
    </HamburgerDialog>
  )
}
