import { useEffect, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import { ApiError, post } from '../api/client'
import type { InteractionPending } from '../api/types'
import type { DialogOutcome } from '../state/eventApplier'

const outcomeDismissMs = 5_000

// resolveDialog posts one answer; a settled code means another surface's
// answer already won, which stays benign wherever it lands.
async function resolveDialog(sessionId: string, body: Record<string, unknown>): Promise<void> {
  try {
    await post(`/api/sessions/${encodeURIComponent(sessionId)}/resolve`, body)
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'settled')) throw err
  }
}

// TouchDialogDock stacks full-width dialog cards above the composer: permit
// and deny answer as separate large buttons, never a compact one-liner against
// 44px touch targets. A dialog answered elsewhere shows its real outcome as an
// auto-dismissing chip; secret dialogs take over a dedicated screen with show
// and hide.
export function TouchDialogDock({
  sessionId,
  dialogs,
  outcomes,
  onAnsweredLocally,
}: {
  sessionId: string
  dialogs: InteractionPending[]
  outcomes: DialogOutcome[]
  onAnsweredLocally: (dialogId: number) => void
}): ReactElement | null {
  if (dialogs.length === 0 && outcomes.length === 0) return null

  return (
    <section className="dialog-dock touch" aria-label="Open dialogs">
      {dialogs.map((dlg) =>
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
          />
        ),
      )}
      {outcomes.map((o) => (
        <ResolvedChip key={`outcome-${o.id}`} outcome={o} />
      ))}
    </section>
  )
}

// TouchDialogCard picks its controls off the shape flags, never the kind hint:
// stacked option buttons, checkbox list plus confirm for multi, large text
// input with an optional chat toggle, cancel everywhere.
function TouchDialogCard({
  dialog,
  sessionId,
  onAnsweredLocally,
}: {
  dialog: InteractionPending
  sessionId: string
  onAnsweredLocally: (dialogId: number) => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const resolve = async (body: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await resolveDialog(sessionId, body)
      onAnsweredLocally(dialog.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed.')
      setBusy(false)
    }
  }

  const multi = dialog.multi === true && dialog.options !== undefined
  return (
    <div className="card dialog-card touch" data-dialog-id={dialog.id}>
      {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
      <p className="dialog-prompt">{dialog.prompt || `[${dialog.kind}]`}</p>
      {multi ? (
        <MultiPick
          options={dialog.options!}
          busy={busy}
          onConfirm={(indexes) => void resolve({ dialogId: dialog.id, indexes })}
        />
      ) : dialog.options !== undefined ? (
        // permit and deny are separate full-width buttons; the answer rides
        // each option's own tap so nothing depends on a compact row
        dialog.options.map((opt: string, i: number) => (
          <button
            key={i}
            type="button"
            className="dialog-choice"
            disabled={busy}
            onClick={() => void resolve({ dialogId: dialog.id, index: i })}
          >
            {opt}
          </button>
        ))
      ) : null}
      {dialog.text === true && (
        <TextAnswer
          busy={busy}
          chat={dialog.chat === true}
          onSend={(text) => void resolve({ dialogId: dialog.id, text, chat: dialog.chat })}
        />
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The answer's text never echoes anywhere upstream; clearing here too keeps
  // a wrong tap from resubmitting a stale value.
  const resolve = async (body: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await resolveDialog(sessionId, body)
      onAnsweredLocally(dialog.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed.')
      setBusy(false)
    } finally {
      setText('')
    }
  }

  return (
    <form
      className="card dialog-card secret-screen"
      onSubmit={(ev) => {
        ev.preventDefault()
        void resolve({ dialogId: dialog.id, text })
      }}
    >
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
      <div style={{ display: 'flex', gap: '0.5em' }}>
        <button className="primary" type="submit" disabled={busy || text === ''}>
          Answer
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void resolve({ dialogId: dialog.id, cancel: true })}
        >
          Cancel
        </button>
      </div>
    </form>
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
}): ReactElement {
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
}): ReactElement {
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
      <input value={text} onChange={(ev) => setText(ev.target.value)} />
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

// ResolvedChip inherits phase 14's auto-dismiss: an answered-elsewhere chip
// clears itself after a few seconds and on tap, never parking under the dock.
function ResolvedChip({ outcome }: { outcome: DialogOutcome }): ReactElement | null {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(false), outcomeDismissMs)
    return () => clearTimeout(timer)
  }, [])

  if (!visible) return null
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
      onClick={() => setVisible(false)}
    >
      Dialog {outcome.id} answered elsewhere — {what}
    </button>
  )
}
