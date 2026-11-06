import { useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'
import { MultiPickList, ResolvedChip, TextAnswer, useMultiPick } from './DialogBodies'
import { useDialogResolve } from './dialogResolve'
import { useDialogAnswerKeys } from './dialogKeys'
import {
  denyAskOption,
  isPermitDialog,
  noteAskOption,
  usePermitNoteAutoAnswer,
} from './decisionNote'

// DialogDock sits above the composer and lists open dialogs oldest first.
// Card variants key on the shape flags, never on kind: a button list for
// options, checkbox list plus confirm for multi, text input with an optional
// chat toggle, password masking for secrets, cancel everywhere. A dialog
// answered elsewhere shows its real outcome as a resolved state, never an error.
//
// Permit cards carry one optional note input: picking Deny or Allow with note
// answers at once and records a pending intent, so the barrier's follow-up
// ask auto-resolves (decisionNote.ts) instead of reading as required input.
//
// Autofocus belongs to the focused pane only (dialog-focus-policy.md):
// autoFocusDialogs marks the dock whose session holds keyboard focus, and only
// that dock's head card may take the caret — on mount, so later arrivals and
// background panes never steal it. Unfocused panes surface through attention.
//
// Digits follow the same focus rule live: while the focused pane's head card
// answers by option index, 1..9 pick that option (dialogKeys.ts), so approvals
// clear from the keys the way the rail jumps panes.
export function DialogDock({
  sessionId,
  dialogs,
  outcomes,
  autoFocusDialogs = true,
  onAnsweredLocally,
  onOutcomeDismissed,
}: {
  sessionId: string
  dialogs: InteractionPending[]
  outcomes: DialogOutcome[]
  autoFocusDialogs?: boolean
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
    <section className="dialog-dock" aria-label="Open dialogs">
      {visible.map((dlg, i) => (
        <DialogCard
          key={dlg.id}
          dialog={dlg}
          sessionId={sessionId}
          head={autoFocusDialogs && i === 0}
          onAnsweredLocally={onAnsweredLocally}
          onNoteIntent={recordIntent}
        />
      ))}
      {outcomes.map((o) => (
        <ResolvedChip key={`outcome-${o.id}`} outcome={o} onDismiss={onOutcomeDismissed} />
      ))}
    </section>
  )
}

// DialogCard picks one variant off the shape flags. Options answer by index,
// multi answers by indexes with an empty list confirming no selection, text
// answers carry chat when offered, and secrets mask their input. On permit
// cards the note input stays optional and options never disable: a picked
// Deny or Allow with note answers by index and hands its text to the dock as
// a pending intent for the barrier's follow-up ask.
function DialogCard({
  dialog,
  sessionId,
  head,
  onAnsweredLocally,
  onNoteIntent,
}: {
  dialog: InteractionPending
  sessionId: string
  // the focused dock's head card: it alone may take the caret, and it answers
  // digit keys while it shows a plain option list
  head: boolean
  onAnsweredLocally: (dialogId: number) => void
  onNoteIntent: (answeredId: number, text: string, deny: boolean) => void
}) {
  // The autofocus decision pins at card mount: a stack position or dock focus
  // gained later never moves the caret, even if this card becomes the head.
  const [mayFocus] = useState(head)
  const [note, setNote] = useState('')
  const { busy, error, resolve } = useDialogResolve(sessionId, dialog.id, onAnsweredLocally)
  const { picked, toggle } = useMultiPick()

  const multi = dialog.multi === true && dialog.options !== undefined
  const permit = isPermitDialog(dialog) && !multi

  // pickOption is the one by-index answer: option buttons and the digit keys
  // both route here, so busy, settled and note-intent handling stay identical
  const pickOption = (i: number) => {
    const opt = dialog.options?.[i]
    if (busy || opt === undefined) return // digits past the list answer nothing
    if (permit && noteAskOption(opt)) {
      onNoteIntent(dialog.id, note, denyAskOption(opt))
    }
    void resolve({ index: i })
  }
  useDialogAnswerKeys(head && !multi && dialog.options !== undefined, (position) =>
    pickOption(position - 1),
  )

  return (
    <div className="card dialog-card" data-dialog-id={dialog.id}>
      {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
      <p className="dialog-prompt">{dialog.prompt || `[${dialog.kind}]`}</p>
      {dialog.text === true && !dialog.secret && (
        <TextAnswer
          busy={busy}
          autoFocus={mayFocus}
          chat={dialog.chat === true}
          onSend={(text) => void resolve({ text, chat: dialog.chat })}
        />
      )}
      {dialog.text === true && dialog.secret && (
        <SecretAnswer busy={busy} autoFocus={mayFocus} onSend={(text) => void resolve({ text })} />
      )}
      {multi && <MultiPickList options={dialog.options!} picked={picked} onToggle={toggle} />}
      {permit && (
        <input
          className="dialog-note"
          placeholder="Note for the agent (optional)"
          value={note}
          autoFocus={mayFocus}
          onChange={(ev) => setNote(ev.target.value)}
        />
      )}
      {/* one compact row for the whole barrier: answers plus cancel together */}
      <div className="dialog-actions">
        {multi ? (
          <button type="button" disabled={busy} onClick={() => void resolve({ indexes: picked })}>
            Confirm
          </button>
        ) : dialog.options !== undefined ? (
          dialog.options.map((opt, i) => (
            <button key={i} type="button" disabled={busy} onClick={() => pickOption(i)}>
              {opt}
            </button>
          ))
        ) : null}
        <div className="dialog-cancel">
          <button type="button" disabled={busy} onClick={() => void resolve({ cancel: true })}>
            Cancel
          </button>
          {error && <span className="error-text"> {error}</span>}
        </div>
      </div>
    </div>
  )
}

// SecretAnswer masks its input; the answer's text never echoes anywhere.
function SecretAnswer({
  busy,
  autoFocus,
  onSend,
}: {
  busy: boolean
  autoFocus: boolean
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    if (text === '') return
    onSend(text)
    setText('')
  }
  return (
    <form onSubmit={submit} className="dialog-text">
      <input
        type="password"
        value={text}
        autoFocus={autoFocus}
        onChange={(ev) => setText(ev.target.value)}
      />
      <button className="primary" type="submit" disabled={busy || text === ''}>
        Answer
      </button>
    </form>
  )
}
