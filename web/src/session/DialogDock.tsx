import type { ReactElement } from 'react'

import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'
import { ResolvedChip } from './DialogBodies'
import { DialogCardBody } from './DialogCardBody'
import { usePermitNoteAutoAnswer } from './decisionNote'

// DialogDock sits above the composer and lists open dialogs oldest first,
// rendering through the shared DialogCardBody. This shell owns placement and
// the focus policy: autofocus belongs to the focused pane only
// (dialog-focus-policy.md), its head card takes the caret on mount, later
// arrivals and background panes never steal it. Digits follow the same rule:
// while the focused head card answers by option index, 1..9 pick that option
// (dialogKeys.ts). A dialog answered elsewhere shows its real outcome as a
// resolved chip that leaves on click or after a moment.
//
// The touch layout stacks full-width cards: permit and deny answer as
// separate large buttons, never a compact one-liner against 44px touch
// targets, and secret dialogs take over a dedicated screen with show and
// hide. A typed permit note rides the Allow or Deny tap, which answers at
// once and records a pending intent so the barrier's follow-up ask
// auto-resolves (decisionNote.ts) instead of reading as required input.
// Answered-elsewhere chips read their detail inline and leave on their own
// or on tap. No head autofocus: focus belongs to the whole-screen composer.
//
// The first arrival announces through one sr-only polite region kept mounted
// for the surface's whole life (dialogAnnouncement below), so assistive tech
// hears what took the composer away exactly when input is lost.
export function DialogDock({
  sessionId,
  dialogs,
  outcomes,
  touch = false,
  autoFocusDialogs = true,
  onAnsweredLocally,
  onOutcomeDismissed,
}: {
  sessionId: string
  dialogs: InteractionPending[]
  outcomes: DialogOutcome[]
  touch?: boolean // full-width cards, inline chip detail, no head autofocus
  autoFocusDialogs?: boolean
  onAnsweredLocally: (dialogId: number) => void
  onOutcomeDismissed: (dialogId: number) => void
}): ReactElement {
  const { suppressed, recordIntent } = usePermitNoteAutoAnswer(
    sessionId,
    dialogs,
    onAnsweredLocally,
  )
  const visible = dialogs.filter((dlg) => !suppressed.has(dlg.id))

  return (
    <>
      {/* mounted empty like Notices, so an arrival mutates live-region content */}
      <span className="sr-only" aria-live="polite">
        {dialogAnnouncement(visible)}
      </span>
      {(visible.length > 0 || outcomes.length > 0) && (
        <section className={`dialog-dock ${touch ? 'touch' : ''}`.trim()} aria-label="Open dialogs">
          {visible.map((dlg, i) => (
            <DialogCardBody
              key={dlg.id}
              dialog={dlg}
              sessionId={sessionId}
              layout={touch ? 'touch' : 'compact'}
              head={!touch && autoFocusDialogs && i === 0}
              onAnsweredLocally={onAnsweredLocally}
              onNoteIntent={recordIntent}
            />
          ))}
          {outcomes.map((o) => (
            <ResolvedChip
              key={`outcome-${o.id}`}
              outcome={o}
              onDismiss={onOutcomeDismissed}
              inlineDetail={touch}
            />
          ))}
        </section>
      )}
    </>
  )
}

// dialogAnnouncement names the oldest open dialog as one polite line, empty
// while nothing blocks so any later arrival always changes the region's text.
// The head staying put keeps stacked arrivals and outcome chips quiet: the
// line moves only when the set empties or the head itself is replaced.
function dialogAnnouncement(visible: InteractionPending[]): string {
  const head = visible[0]
  if (head === undefined) return ''
  // an empty prompt reads by its kind, matching the card's own fallback
  return `A dialog needs an answer: ${head.prompt || `[${head.kind}]`}`
}
