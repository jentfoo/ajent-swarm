import { useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { ModalShell } from '../ui/ModalShell'
import { ChainTargets } from '../workspace/ChainPicker'
import { useWorkspace } from '../providers/workspace'
import { SettingsMenu } from './SettingsMenu'

// HamburgerDialog is the open/close shell both ☰ settings menus share: a
// trigger plus, when open, children in a centered modal so edge-of-grid cards
// keep the menu on page. `label` names trigger and dialog, `title` overrides
// the trigger hover text.
export function HamburgerDialog({
  label,
  title,
  children,
}: {
  label: string
  title?: string
  children: ReactNode
}): ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={title ?? label}
        onClick={() => setOpen(true)}
      >
        ☰
      </button>
      {open && (
        <ModalShell className="settings-modal" label={label} onClose={() => setOpen(false)}>
          {children}
        </ModalShell>
      )}
    </>
  )
}

// AgentSettingsMenu is the ☰ affordance a session's own chrome carries: the
// shared settings.get/settings.set menu over that session's control socket,
// plus the keyboard routes into chaining. "Queue follow up session" lands a
// fresh-session draft with this session as the parent, "Chain after this
// session" swaps the modal into a target picker, picking one hands the draft
// to the shared chain dialog with this session as the parent. It lives in the
// chat header and on session cards, so a session is always the context for
// its agent settings, never a picker elsewhere.
export function AgentSettingsMenu({ sessionId }: { sessionId: string }): ReactElement {
  const { setChainDraft, setQueueDraft } = useWorkspace()
  const [picking, setPicking] = useState(false)

  return (
    <HamburgerDialog label="Agent settings" title="Agent settings for this session">
      {picking ? (
        <>
          <p className="muted">Pick the session that runs after this one:</p>
          <ChainTargets
            parentId={sessionId}
            onPick={(childId) => {
              setPicking(false)
              setChainDraft({ parentId: sessionId, childId })
            }}
          />
        </>
      ) : (
        <>
          <SettingsMenu sessionId={sessionId} />
          <div className="settings-chain-entry">
            <button type="button" onClick={() => setQueueDraft({ parentId: sessionId })}>
              Queue follow up session…
            </button>
            <button type="button" onClick={() => setPicking(true)}>
              Chain after this session…
            </button>
          </div>
        </>
      )}
    </HamburgerDialog>
  )
}
