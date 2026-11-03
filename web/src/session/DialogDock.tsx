import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError, post } from '../api/client'
import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'

// Resolved chips linger briefly so an answer is visible, then leave on their
// own: dialogs settled elsewhere never park under the dock until the cap.
const outcomeTtlMs = 4_000

// DialogDock sits above the composer and lists open dialogs oldest first.
// Card variants key on the shape flags, never on kind: a button list for
// options, checkbox list plus confirm for multi, text input with an optional
// chat toggle, password masking for secrets, cancel everywhere. A dialog
// answered elsewhere shows its real outcome as a resolved state, never an error.
export function DialogDock({
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
}) {
  if (dialogs.length === 0 && outcomes.length === 0) return null

  return (
    <section className="dialog-dock" aria-label="Open dialogs">
      {dialogs.map((dlg) => (
        <DialogCard
          key={dlg.id}
          dialog={dlg}
          sessionId={sessionId}
          onAnsweredLocally={onAnsweredLocally}
        />
      ))}
      {outcomes.map((o) => (
        <ResolvedChip key={`outcome-${o.id}`} outcome={o} onDismiss={onOutcomeDismissed} />
      ))}
    </section>
  )
}

// ResolvedChip self-dismisses after a few seconds and leaves on click, so an
// answer decided elsewhere never becomes residue. The timer runs once per id:
// the callback rides a ref, so parent re-renders from streaming or polling
// never reset the clock.
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

  const what = outcome.cancelled
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
      title="Dismiss"
      onClick={() => onDismiss(outcome.id)}
    >
      Dialog {outcome.id} answered elsewhere — {what}
    </button>
  )
}

// DialogCard picks one variant off the shape flags. Options answer by index,
// multi answers by indexes with an empty list confirming no selection, text
// answers carry chat when offered, and secrets mask their input.
function DialogCard({
  dialog,
  sessionId,
  onAnsweredLocally,
}: {
  dialog: InteractionPending
  sessionId: string
  onAnsweredLocally: (dialogId: number) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const togglePicked = (i: number) =>
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))

  // Settled is benign: the first answer won, wherever it came from. Both a
  // settled:true reply and a settled wire code resolve quietly.
  const resolve = async (body: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await post(`/api/sessions/${encodeURIComponent(sessionId)}/resolve`, body).catch(
        (err: unknown) => {
          if (!(err instanceof ApiError && err.code === 'settled')) throw err
        },
      )
      onAnsweredLocally(dialog.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed.')
    } finally {
      setBusy(false)
    }
  }

  const multi = dialog.multi === true && dialog.options !== undefined
  return (
    <div className="card dialog-card" data-dialog-id={dialog.id}>
      {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
      <p className="dialog-prompt">{dialog.prompt || `[${dialog.kind}]`}</p>
      {dialog.text === true && !dialog.secret && (
        <TextAnswer
          busy={busy}
          chat={dialog.chat === true}
          onSend={(text) => void resolve({ dialogId: dialog.id, text, chat: dialog.chat })}
        />
      )}
      {dialog.text === true && dialog.secret && (
        <SecretAnswer busy={busy} onSend={(text) => void resolve({ dialogId: dialog.id, text })} />
      )}
      {multi && (
        <MultiChecklist options={dialog.options!} picked={picked} onToggle={togglePicked} />
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
              onClick={() => void resolve({ dialogId: dialog.id, index: i })}
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
  onSend,
}: {
  busy: boolean
  chat: boolean
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
      <input value={text} autoFocus onChange={(ev) => setText(ev.target.value)} />
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
function SecretAnswer({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    if (text === '') return
    onSend(text)
    setText('')
  }
  return (
    <form onSubmit={submit} className="dialog-text">
      <input type="password" value={text} autoFocus onChange={(ev) => setText(ev.target.value)} />
      <button className="primary" type="submit" disabled={busy || text === ''}>
        Answer
      </button>
    </form>
  )
}
