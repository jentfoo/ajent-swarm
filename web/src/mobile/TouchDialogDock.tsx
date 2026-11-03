import { useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'
import { MultiPickList, ResolvedChip, TextAnswer, useMultiPick } from '../session/DialogBodies'
import { useDialogResolve } from '../session/dialogResolve'
import {
  isPermitDialog,
  pickPermitOption,
  permitChoices,
  usePermitNoteAutoAnswer,
} from '../session/decisionNote'

// TouchDialogDock stacks full-width dialog cards above the composer: permit
// and deny answer as separate large buttons, never a compact one-liner against
// 44px touch targets. Permit cards hide ajent's "Allow with note" behind one
// optional note input: a typed note rides the Allow or Deny tap, which answers
// at once and records a pending intent so the barrier's follow-up ask
// auto-resolves (decisionNote.ts) instead of reading as required input. A
// dialog answered elsewhere shows its real outcome as a chip that leaves on
// its own or on tap; secret dialogs take over a dedicated screen with show and
// hide.
export function TouchDialogDock({
  sessionId,
  dialogs,
  outcomes,
  onAnsweredLocally,
  onOutcomeDismissed,
}: {
  sessionId: string
  dialogs: InteractionPending[]
  outcomes: DialogOutcome[]
  onAnsweredLocally: (dialogId: number) => void
  onOutcomeDismissed: (dialogId: number) => void
}): ReactElement | null {
  const { suppressed, recordIntent } = usePermitNoteAutoAnswer(
    sessionId,
    dialogs,
    onAnsweredLocally,
  )
  const visible = dialogs.filter((dlg) => !suppressed.has(dlg.id))
  if (visible.length === 0 && outcomes.length === 0) return null

  return (
    <section className="dialog-dock touch" aria-label="Open dialogs">
      {visible.map((dlg) =>
        dlg.secret ? (
          <SecretDialogScreen
            key={dlg.id}
            dialog={dlg}
            sessionId={sessionId}
            onAnsweredLocally={onAnsweredLocally}
          />
        ) : (
          <TouchDialogCard
            key={dlg.id}
            dialog={dlg}
            sessionId={sessionId}
            onAnsweredLocally={onAnsweredLocally}
            onNoteIntent={recordIntent}
          />
        ),
      )}
      {outcomes.map((o) => (
        <ResolvedChip
          key={`outcome-${o.id}`}
          outcome={o}
          onDismiss={onOutcomeDismissed}
          inlineDetail
        />
      ))}
    </section>
  )
}

// TouchDialogCard picks its controls off the shape flags, never the kind hint:
// stacked option buttons, checkbox list plus confirm for multi, large text
// input with an optional chat toggle, cancel everywhere. On permit cards
// "Allow with note" is hidden: the note input stays optional and buttons never
// disable, a typed note riding the Allow or Deny tap as a pending intent.
function TouchDialogCard({
  dialog,
  sessionId,
  onAnsweredLocally,
  onNoteIntent,
}: {
  dialog: InteractionPending
  sessionId: string
  onAnsweredLocally: (dialogId: number) => void
  onNoteIntent: (answeredId: number, text: string, deny: boolean) => void
}): ReactElement {
  const [note, setNote] = useState('')
  const { busy, error, resolve } = useDialogResolve(sessionId, dialog.id, onAnsweredLocally)
  const { picked, toggle } = useMultiPick()

  const multi = dialog.multi === true && dialog.options !== undefined
  const permit = isPermitDialog(dialog) && !multi

  // permit cards hide "Allow with note"; other dialogs render every option
  const options = dialog.options ?? []
  const choices = permit
    ? permitChoices(options)
    : options.map((label, index) => ({ label, index }))

  const answer = (pos: number) => {
    const choice = choices[pos]
    if (choice === undefined) return
    const picked = permit ? pickPermitOption(options, choice.index, note) : { index: choice.index }
    if (picked.deny !== undefined) onNoteIntent(dialog.id, note, picked.deny)
    void resolve({ index: picked.index })
  }

  return (
    <div className="card dialog-card touch" data-dialog-id={dialog.id}>
      {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
      <p className="dialog-prompt">{dialog.prompt || `[${dialog.kind}]`}</p>
      {permit && (
        <input
          className="dialog-note"
          placeholder="Note for the agent (optional)"
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
        />
      )}
      {multi ? (
        <MultiPickList options={dialog.options!} picked={picked} onToggle={toggle}>
          <button
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => void resolve({ indexes: picked })}
          >
            Confirm
          </button>
        </MultiPickList>
      ) : dialog.options !== undefined ? (
        // permit and deny are separate full-width buttons; the answer rides
        // each option's own tap so nothing depends on a compact row
        choices.map((choice, pos) => (
          <button
            key={choice.index}
            type="button"
            className="dialog-choice"
            disabled={busy}
            onClick={() => answer(pos)}
          >
            {choice.label}
          </button>
        ))
      ) : null}
      {dialog.text === true && (
        <TextAnswer
          busy={busy}
          chat={dialog.chat === true}
          onSend={(text) => void resolve({ text, chat: dialog.chat })}
        />
      )}
      <div className="dialog-cancel">
        <button type="button" disabled={busy} onClick={() => void resolve({ cancel: true })}>
          Cancel
        </button>
        {error && <span className="error-text"> {error}</span>}
      </div>
    </div>
  )
}

// SecretDialogScreen takes over the view: a dedicated screen keeps the answer
// off shared screens, with show and hide toggling the masked input.
function SecretDialogScreen({
  dialog,
  sessionId,
  onAnsweredLocally,
}: {
  dialog: InteractionPending
  sessionId: string
  onAnsweredLocally: (dialogId: number) => void
}): ReactElement {
  const [text, setText] = useState('')
  const [show, setShow] = useState(false)
  const { busy, error, resolve } = useDialogResolve(sessionId, dialog.id, onAnsweredLocally)

  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    if (text === '') return
    // the answer's text never echoes anywhere; clearing at once keeps a wrong
    // tap from resubmitting a stale value
    const answer = text
    setText('')
    void resolve({ text: answer })
  }

  return (
    <form className="card dialog-card touch secret-screen" onSubmit={submit}>
      {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
      <p className="dialog-prompt">{dialog.prompt || `[${dialog.kind}]`}</p>
      <div className="secret-row">
        <input
          type={show ? 'text' : 'password'}
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          aria-label="Secret answer"
          autoFocus
        />
        <button type="button" onClick={() => setShow(!show)} aria-pressed={show}>
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button className="primary" type="submit" disabled={busy || text === ''}>
          Answer
        </button>
        <button type="button" disabled={busy} onClick={() => void resolve({ cancel: true })}>
          Cancel
        </button>
      </div>
    </form>
  )
}
