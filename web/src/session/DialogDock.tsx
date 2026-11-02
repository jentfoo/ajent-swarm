import { useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError, post } from '../api/client'
import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'

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
}: {
  sessionId: string
  dialogs: InteractionPending[]
  outcomes: DialogOutcome[]
  onAnsweredLocally: (dialogId: number) => void
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
        <ResolvedChip key={`outcome-${o.id}`} outcome={o} />
      ))}
    </section>
  )
}

function ResolvedChip({ outcome }: { outcome: DialogOutcome }) {
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
    <div className="card resolved-dialog" role="status">
      Dialog {outcome.id} answered elsewhere — {what}
    </div>
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
      {multi ? (
        <MultiPick
          options={dialog.options!}
          busy={busy}
          onConfirm={(indexes) => void resolve({ dialogId: dialog.id, indexes })}
        />
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
  )
}

function MultiPick({
  options,
  busy,
  onConfirm,
}: {
  options: string[]
  busy: boolean
  onConfirm: (indexes: number[]) => void
}) {
  const [picked, setPicked] = useState<number[]>([])
  return (
    <div className="multipick">
      {options.map((opt, i) => (
        <label key={i} className="multipick-row">
          <input
            type="checkbox"
            checked={picked.includes(i)}
            onChange={() =>
              setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))
            }
          />
          {opt}
        </label>
      ))}
      <button className="primary" type="button" disabled={busy} onClick={() => onConfirm(picked)}>
        Confirm
      </button>
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
