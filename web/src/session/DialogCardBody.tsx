import { useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'

import type { InteractionPending } from '../api/types'
import { MultiPickList, TextAnswer, useMultiPick } from './DialogBodies'
import { answerDigitCount, useDialogAnswerKeys } from './dialogKeys'
import { useDialogResolve } from './dialogResolve'
import { isPermitDialog, pickPermitOption, permitChoices } from './decisionNote'
import { useSubmitPress } from './submitPress'

// DialogCardLayout picks a card's control arrangement: compact one-row answers
// for the desktop dock, stacked full-width controls for touch.
export type DialogCardLayout = 'compact' | 'touch'

interface DialogCardBodyProps {
  dialog: InteractionPending
  sessionId: string
  layout: DialogCardLayout
  head?: boolean
  // an ended run leaves its ask behind with no way to answer: the card
  // renders as inert context, every control is gone
  readOnly?: boolean
  onAnsweredLocally: (dialogId: number) => void
  onNoteIntent: (answeredId: number, text: string, deny: boolean) => void
}

// DialogCardBody is the one dialog card body every dock renders. It dispatches
// on the shape flags, never the kind hint: a button list for options, checkbox
// list plus confirm for multi, text input with an optional chat toggle,
// password masking for secrets, cancel everywhere. On permit cards "Allow with
// note" is hidden: options never disable, and a typed note rides the Allow or
// Deny pick as a pending intent for the barrier's follow-up ask
// (decisionNote.ts).
//
// layout arranges controls only. head marks the focused dock's head card: it
// alone may take the caret on mount, later arrivals and background panes never
// steal it, and while it shows a plain option list its digits answer by
// position (dialogKeys.ts). Touch surfaces grant no head, keeping taps free of
// a stolen caret. readOnly swaps the whole body for the inert context card an
// ended run leaves behind.
export function DialogCardBody({
  dialog,
  sessionId,
  layout,
  head = false,
  readOnly = false,
  onAnsweredLocally,
  onNoteIntent,
}: DialogCardBodyProps): ReactElement {
  if (readOnly) return <EndedDialogBody dialog={dialog} />
  // touch secrets take over a dedicated screen with show and hide, every
  // other shape renders the standard card. The split holds no hooks, so one
  // dialog's flags flipping swaps the child instead of reordering hook calls.
  if (layout === 'touch' && dialog.secret === true) {
    return (
      <SecretDialogScreen
        dialog={dialog}
        sessionId={sessionId}
        onAnsweredLocally={onAnsweredLocally}
      />
    )
  }
  return (
    <StandardDialogBody
      dialog={dialog}
      sessionId={sessionId}
      layout={layout}
      head={head}
      onAnsweredLocally={onAnsweredLocally}
      onNoteIntent={onNoteIntent}
    />
  )
}

// EndedDialogBody renders one dialog an ended run left pending: the ask and
// the choices it offered stay visible as context, no answer control exists
// because no resolve can land on a dead run. Layout collapses: with nothing to
// tap, touch and compact read the same.
function EndedDialogBody({ dialog }: { dialog: InteractionPending }): ReactElement {
  return (
    <div className="card dialog-card ended" data-dialog-id={dialog.id}>
      {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
      <p className="dialog-prompt">{dialog.prompt || `[${dialog.kind}]`}</p>
      {dialog.options !== undefined && (
        <ul className="dialog-options-ended">
          {dialog.options.map((label, i) => (
            <li key={i}>{label}</li>
          ))}
        </ul>
      )}
      <p className="muted">Unanswered when the session ended.</p>
    </div>
  )
}

// StandardDialogBody renders every shape that stays on a standard card, both
// arrangements alike: answers differ in placement, never in the resolve path.
function StandardDialogBody({
  dialog,
  sessionId,
  layout,
  head = false,
  onAnsweredLocally,
  onNoteIntent,
}: DialogCardBodyProps): ReactElement {
  // The autofocus decision pins at card mount: a stack position or dock focus
  // gained later never moves the caret, even if this card becomes the head.
  const [mayFocus] = useState(head)
  const [note, setNote] = useState('')
  const { busy, error, resolve } = useDialogResolve(sessionId, dialog.id, onAnsweredLocally)
  const { picked, toggle } = useMultiPick()

  const multi = dialog.multi === true && dialog.options !== undefined
  const permit = isPermitDialog(dialog) && !multi

  // permit cards hide "Allow with note", other dialogs render every option
  const options = dialog.options ?? []
  const choices = permit
    ? permitChoices(options)
    : options.map((label, index) => ({ label, index }))

  // pickChoice is the one by-position answer over the rendered buttons: clicks
  // and digit keys both route here, so busy, settled and note-intent handling
  // stay identical
  const pickChoice = (pos: number) => {
    const choice = choices[pos]
    if (busy || choice === undefined) return // digits past the list answer nothing
    const picked = permit ? pickPermitOption(options, choice.index, note) : { index: choice.index }
    if (picked.deny !== undefined) onNoteIntent(dialog.id, note, picked.deny)
    void resolve({ index: picked.index })
  }
  useDialogAnswerKeys(head && !multi && dialog.options !== undefined, (position) =>
    pickChoice(position - 1),
  )

  if (layout === 'compact') {
    return (
      <div className="card dialog-card" data-dialog-id={dialog.id}>
        {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
        <p className="dialog-prompt">{dialog.prompt || `[${dialog.kind}]`}</p>
        {dialog.text === true && !dialog.secret && (
          <TextAnswer
            busy={busy}
            autoFocus={mayFocus}
            chat={dialog.chat === true}
            onSend={(text) => resolve({ text, chat: dialog.chat })}
          />
        )}
        {dialog.text === true && dialog.secret && (
          <SecretAnswer
            busy={busy}
            autoFocus={mayFocus}
            onSend={(text) => void resolve({ text })}
          />
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
            choices.map((choice, pos) => {
              // only the head card answers digits (dialogKeys.ts), so only it
              // names them, aria-keyshortcuts exposes the key accessibly while
              // the hidden badge keeps the button's name its label alone
              const digit = head && pos < answerDigitCount ? String(pos + 1) : undefined
              return (
                <button
                  key={choice.index}
                  type="button"
                  disabled={busy}
                  aria-keyshortcuts={digit}
                  onClick={() => pickChoice(pos)}
                >
                  {digit && (
                    <span className="dialog-digit" aria-hidden="true">
                      {digit}
                    </span>
                  )}
                  {choice.label}
                </button>
              )
            })
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

  return (
    // touch cards stack full-width controls against the 44px target floor:
    // permit and deny answer as separate large buttons, never a compact
    // one-liner, and option buttons carry no digit badge because digits only
    // ever answer the desktop head card (dialogKeys.ts), so naming them here
    // would lie
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
        // the answer rides each option's own tap, so nothing depends on a
        // compact row
        choices.map((choice, pos) => (
          <button
            key={choice.index}
            type="button"
            className="dialog-choice"
            disabled={busy}
            onClick={() => pickChoice(pos)}
          >
            {choice.label}
          </button>
        ))
      ) : null}
      {dialog.text === true && (
        <TextAnswer
          busy={busy}
          chat={dialog.chat === true}
          onSend={(text) => resolve({ text, chat: dialog.chat })}
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

// SecretAnswer masks its input, the answer's text never echoes anywhere.
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
  const inputRef = useRef<HTMLInputElement>(null)
  const empty = text === ''
  const press = useSubmitPress(inputRef, empty, busy)
  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    // the disabled button blocks clicks, Enter still submits while busy
    if (busy || empty) return
    onSend(text)
    setText('')
  }
  return (
    <form onSubmit={submit} className="dialog-text">
      <input
        ref={inputRef}
        type="password"
        value={text}
        autoFocus={autoFocus}
        aria-label="Secret answer"
        onChange={(ev) => setText(ev.target.value)}
      />
      <button
        className={press.keyboardDismiss ? 'primary keyboard-dismiss' : 'primary'}
        type="submit"
        disabled={press.disabled}
        {...press.handlers}
      >
        Answer
      </button>
    </form>
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
  const inputRef = useRef<HTMLInputElement>(null)
  const { busy, error, resolve } = useDialogResolve(sessionId, dialog.id, onAnsweredLocally)
  const empty = text === ''
  const press = useSubmitPress(inputRef, empty, busy)

  const submit = (ev: FormEvent) => {
    ev.preventDefault()
    if (busy || empty) return
    // the answer's text never echoes anywhere, clearing at once keeps a wrong
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
          ref={inputRef}
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
        <button
          className={press.keyboardDismiss ? 'primary keyboard-dismiss' : 'primary'}
          type="submit"
          disabled={press.disabled}
          {...press.handlers}
        >
          Answer
        </button>
        <button type="button" disabled={busy} onClick={() => void resolve({ cancel: true })}>
          Cancel
        </button>
      </div>
    </form>
  )
}
