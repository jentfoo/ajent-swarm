import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import { ApiError } from '../api/client'
import { sessions } from '../api/endpoints'
import type { InteractionPending, ResolveAnswer } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'
import {
  denyAskOption,
  isPermitDialog,
  noteAskOption,
  usePermitNoteAutoAnswer,
} from './decisionNote'

// Resolved chips linger briefly so an answer is visible, then leave on their
// own: dialogs settled elsewhere never park under the dock until the cap.
const outcomeTtlMs = 4_000

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
          autoFocusAnswer={autoFocusDialogs && i === 0}
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

// ResolvedChip self-dismisses after a few seconds and leaves on click, so an
// answer decided elsewhere never becomes residue. The timer is per id and
// ignores parent re-renders; hover keeps what was picked.
function ResolvedChip({
  outcome,
  onDismiss,
}: {
  outcome: DialogOutcome
  onDismiss: (dialogId: number) => void
}) {
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])
  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(outcome.id), outcomeTtlMs)
    return () => clearTimeout(timer)
  }, [outcome.id])

  const detail = outcome.cancelled
    ? 'cancelled'
    : outcome.indexes !== undefined && outcome.indexes.length > 0
      ? `answered: options ${outcome.indexes.map((i) => i + 1).join(', ')}`
      : outcome.index !== undefined
        ? `answered: option ${outcome.index + 1}`
        : outcome.answered
          ? 'answered'
          : 'closed'
  return (
    <button
      type="button"
      className="card resolved-dialog"
      role="status"
      title={`Dialog ${outcome.id} answered elsewhere — ${detail}`}
      onClick={() => onDismiss(outcome.id)}
    >
      {outcome.cancelled ? 'Dialog cancelled' : 'Dialog answered'}
    </button>
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
  autoFocusAnswer,
  onAnsweredLocally,
  onNoteIntent,
}: {
  dialog: InteractionPending
  sessionId: string
  autoFocusAnswer: boolean
  onAnsweredLocally: (dialogId: number) => void
  onNoteIntent: (answeredId: number, text: string, deny: boolean) => void
}) {
  // The autofocus decision pins at card mount: a stack position or dock focus
  // gained later never moves the caret, even if this card becomes the head.
  const [mayFocus] = useState(autoFocusAnswer)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [note, setNote] = useState('')
  const togglePicked = (i: number) =>
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))

  // Settled is benign: the first answer won, wherever it came from. Both a
  // settled:true reply and a settled wire code resolve quietly.
  const resolve = async (body: ResolveAnswer) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await sessions.resolve(sessionId, body).catch((err: unknown) => {
        if (!(err instanceof ApiError && err.code === 'settled')) throw err
      })
      onAnsweredLocally(dialog.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed.')
    } finally {
      setBusy(false)
    }
  }

  const multi = dialog.multi === true && dialog.options !== undefined
  const permit = isPermitDialog(dialog) && !multi
  return (
    <div className="card dialog-card" data-dialog-id={dialog.id}>
      {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
      <p className="dialog-prompt">{dialog.prompt || `[${dialog.kind}]`}</p>
      {dialog.text === true && !dialog.secret && (
        <TextAnswer
          busy={busy}
          autoFocus={mayFocus}
          chat={dialog.chat === true}
          onSend={(text) => void resolve({ dialogId: dialog.id, text, chat: dialog.chat })}
        />
      )}
      {dialog.text === true && dialog.secret && (
        <SecretAnswer
          busy={busy}
          autoFocus={mayFocus}
          onSend={(text) => void resolve({ dialogId: dialog.id, text })}
        />
      )}
      {multi && (
        <MultiChecklist options={dialog.options!} picked={picked} onToggle={togglePicked} />
      )}
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
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolve({ dialogId: dialog.id, indexes: picked })}
          >
            Confirm
          </button>
        ) : dialog.options !== undefined ? (
          dialog.options.map((opt: string, i: number) => (
            <button
              key={i}
              type="button"
              disabled={busy}
              onClick={() => {
                if (permit && noteAskOption(opt)) {
                  onNoteIntent(dialog.id, note, denyAskOption(opt))
                }
                void resolve({ dialogId: dialog.id, index: i })
              }}
            >
              {opt}
            </button>
          ))
        ) : null}
        <div className="dialog-cancel">
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolve({ dialogId: dialog.id, cancel: true })}
          >
            Cancel
          </button>
          {error && <span className="error-text"> {error}</span>}
        </div>
      </div>
    </div>
  )
}

// MultiChecklist is the checkbox list of a multi dialog; its Confirm lives in
// the action row beside Cancel, so every answer stays one compact line.
function MultiChecklist({
  options,
  picked,
  onToggle,
}: {
  options: string[]
  picked: number[]
  onToggle: (index: number) => void
}) {
  return (
    <div className="multipick">
      {options.map((opt, i) => (
        <label key={i} className="multipick-row">
          <input type="checkbox" checked={picked.includes(i)} onChange={() => onToggle(i)} />
          {opt}
        </label>
      ))}
    </div>
  )
}
function TextAnswer({
  busy,
  chat,
  autoFocus,
  onSend,
}: {
  busy: boolean
  chat: boolean
  autoFocus: boolean
  onSend: (text: string) => void
}) {
  const [text, setText] = useState('')
  const [asChat, setAsChat] = useState(false)
  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    if (text.trim() === '') return
    onSend(text)
    setText('')
  }
  return (
    <form onSubmit={submit} className="dialog-text">
      <input value={text} autoFocus={autoFocus} onChange={(ev) => setText(ev.target.value)} />
      {chat && (
        <label className="chat-toggle">
          <input type="checkbox" checked={asChat} onChange={(ev) => setAsChat(ev.target.checked)} />
          reply in my own words
        </label>
      )}
      <button type="submit" disabled={busy || text.trim() === ''}>
        Answer{chat && asChat ? ' (chat)' : ''}
      </button>
    </form>
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
