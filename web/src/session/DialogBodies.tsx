import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement, ReactNode } from 'react'

import type { DialogOutcome } from '../state/eventApplier'

// Resolved chips linger a moment so an answer is visible, then leave on their
// own: dialogs settled elsewhere never park under the dock until the cap.
export const outcomeChipTtlMs = 1_500

// ResolvedChip is the answered-elsewhere chip every dock renders. It
// self-dismisses shortly after appearing and leaves on click, so an answer
// decided elsewhere never lingers in view or store state; the timer is per id
// and ignores parent re-renders. Touch surfaces read the detail inline,
// desktop keeps the same line one hover away.
export function ResolvedChip({
  outcome,
  onDismiss,
  inlineDetail = false,
}: {
  outcome: DialogOutcome
  onDismiss: (dialogId: number) => void
  inlineDetail?: boolean
}): ReactElement {
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])
  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(outcome.id), outcomeChipTtlMs)
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
  const title = `Dialog ${outcome.id} answered elsewhere — ${detail}`
  return (
    <button
      type="button"
      className="card resolved-dialog"
      role="status"
      title={title}
      onClick={() => onDismiss(outcome.id)}
    >
      {inlineDetail ? title : outcome.cancelled ? 'Dialog cancelled' : 'Dialog answered'}
    </button>
  )
}

// TextAnswer is the free-text answer body: the input, the chat toggle when the
// dialog offers one, and the send button. autoFocus stays opt-in so only a
// chrome whose focus policy allows the caret passes it.
export function TextAnswer({
  busy,
  chat,
  autoFocus = false,
  onSend,
}: {
  busy: boolean
  chat: boolean
  autoFocus?: boolean
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

// useMultiPick owns one multi dialog's checked set, so both chromes share the
// membership rule while placing their own confirm control.
export function useMultiPick(): { picked: number[]; toggle: (index: number) => void } {
  const [picked, setPicked] = useState<number[]>([])
  const toggle = useCallback(
    (index: number) =>
      setPicked((p) => (p.includes(index) ? p.filter((x) => x !== index) : [...p, index])),
    [],
  )
  return { picked, toggle }
}

// MultiPickList is the checkbox body of a multi dialog. Where the confirm
// button sits is card layout, so it rides in as children and stays with each
// chrome.
export function MultiPickList({
  options,
  picked,
  onToggle,
  children,
}: {
  options: string[]
  picked: number[]
  onToggle: (index: number) => void
  children?: ReactNode
}): ReactElement {
  return (
    <div className="multipick">
      {options.map((opt, i) => (
        <label key={i} className="multipick-row">
          <input type="checkbox" checked={picked.includes(i)} onChange={() => onToggle(i)} />
          {opt}
        </label>
      ))}
      {children}
    </div>
  )
}
