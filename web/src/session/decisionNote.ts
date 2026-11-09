import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'

import { ApiError } from '../api/client'
import { sessions } from '../api/endpoints'
import type { InteractionPending, ResolveAnswer } from '../api/types'

// Markers match case-insensitively as substrings so upstream wording drift
// ("Deny this call", "add a reason for denying") never breaks the flow. Option
// labels come from ajent's pkg/permit/prompt.go optionsFor (the session grant
// always ends "for session"), ask prompts from barrier.go resolveChoice.
const allowNoteOptionMarker = 'allow with note'
const denyOptionMarker = 'deny'
const sessionOptionMarker = 'for session'
const denyAskMarker = 'for denying'
const allowAskMarker = 'for allowing'

// intentTtlMs clears a pending note: an ask not matched within the window
// renders for hand answering instead of consuming a stale decision.
const intentTtlMs = 10_000

// isPermitDialog reports whether dialog is one of ajent's tool approval
// prompts, keyed by its option labels rather than the kind hint.
export function isPermitDialog(dialog: InteractionPending): boolean {
  return dialog.options?.some(noteAskOption) ?? false
}

// reasonAskDeny tolerantly matches the barrier's follow-up note ask by
// prompt: "reason for denying" or "note for allowing" today. It reports the
// ask's flavor, undefined when the prompt is not the note ask at all.
export function reasonAskDeny(prompt: string): boolean | undefined {
  const p = prompt.toLowerCase()
  if (p.includes(denyAskMarker)) return true
  if (p.includes(allowAskMarker)) return false
  return undefined
}

// opensNoteAsk reports whether picking this permit option opens the follow-up
// ask (Deny and Allow with note do, Allow and session allows do not).
function noteAskOption(label: string): boolean {
  const l = label.toLowerCase()
  return l.includes(allowNoteOptionMarker) || l.includes(denyOptionMarker)
}

// denyAskOption reports whether that follow-up asks for a denial reason rather
// than an allow note, keeping two pending decisions' notes apart.
function denyAskOption(label: string): boolean {
  return label.toLowerCase().includes(denyOptionMarker)
}

// allowNoteOption reports whether the label is ajent's "Allow with note"
// choice, which permit cards hide because their own note input covers it.
function allowNoteOption(label: string): boolean {
  return label.toLowerCase().includes(allowNoteOptionMarker)
}

// sessionAllowOption reports whether picking remembers for the session, ajent
// applies that grant without consulting a note.
function sessionAllowOption(label: string): boolean {
  return label.toLowerCase().includes(sessionOptionMarker)
}

// PermitChoice is one rendered option button on a permit card: its label and
// the dialog answer position it resolves.
interface PermitChoice {
  label: string
  index: number
}

// permitChoices lists the buttons a permit card renders with "Allow with note"
// hidden: the card's own note input covers that choice, and its answer rides
// Allow or Deny picks instead (pickPermitOption).
export function permitChoices(options: readonly string[]): PermitChoice[] {
  return options
    .map((label, index) => ({ label, index }))
    .filter(({ label }) => !allowNoteOption(label))
}

// PermitAnswer is how a picked permit option resolves: the dialog answer index
// plus the follow-up ask's flavor when one auto-answers (undefined for none).
interface PermitAnswer {
  index: number
  deny?: boolean
}

// pickPermitOption maps a picked permit option to its answer. A typed note
// rides Allow and Deny picks: plain Allow answers as the hidden "Allow with
// note" choice so the barrier's note ask auto-resolves, while session allows
// answer unchanged because ajent never consults a note for them.
export function pickPermitOption(
  options: readonly string[],
  picked: number,
  note: string,
): PermitAnswer {
  const label = options[picked] ?? ''
  if (denyAskOption(label)) return { index: picked, deny: true }
  if (allowNoteOption(label)) return { index: picked, deny: false } // defensive; hidden in practice
  const noteIdx = options.findIndex(allowNoteOption)
  if (note.trim() === '' || noteIdx < 0 || sessionAllowOption(label)) return { index: picked }
  return { index: noteIdx, deny: false } // a typed note turns Allow into allow-with-note
}

// PermitNoteIntent is one answered permit card awaiting its follow-up ask.
interface PermitNoteIntent {
  deny: boolean // a "for denying" ask consumes this; false consumes "for allowing"
  text: string // trimmed note; '' meaning cancel the ask so the barrier skips it
}

// takeIntent consumes the oldest intent matching the ask's flavor.
// undefined when no live intent waits.
function takeIntent(intents: Map<number, PermitNoteIntent>, denyAsk: boolean): string | undefined {
  for (const [answeredId, intent] of intents) {
    if (intent.deny !== denyAsk) continue
    intents.delete(answeredId)
    return intent.text
  }
  return undefined
}

// Suppression transitions the ask cards kept off screen while their
// auto-answer round trip lands.
type SuppressionAction =
  | { type: 'sync'; live: ReadonlySet<number> } // announce-tracked ids only
  | { type: 'hide'; ids: number[]; live: ReadonlySet<number> } // auto-answers begin
  | { type: 'reveal'; id: number } // a resolve failed; hand answering takes over

// prune drops ids the session no longer announces, their settled events have
// landed, so nothing flash-bound remains to hide. Returns prev when unchanged,
// so scans that find nothing never re-render the dock.
function prune(prev: ReadonlySet<number>, live: ReadonlySet<number>): ReadonlySet<number> {
  let changed = false
  const next = new Set(prev)
  for (const id of prev) {
    if (!live.has(id)) {
      next.delete(id)
      changed = true
    }
  }
  return changed ? next : prev
}

function suppressionReducer(
  prev: ReadonlySet<number>,
  action: SuppressionAction,
): ReadonlySet<number> {
  switch (action.type) {
    case 'sync':
      return prune(prev, action.live)
    case 'hide': {
      const pruned = prune(prev, action.live)
      const next = new Set(pruned)
      let changed = pruned !== prev
      for (const id of action.ids) {
        if (!next.has(id)) {
          next.add(id)
          changed = true
        }
      }
      return changed ? next : prev
    }
    case 'reveal': {
      if (!prev.has(action.id)) return prev
      const next = new Set(prev)
      next.delete(action.id)
      return next
    }
  }
}

const noSuppression: ReadonlySet<number> = new Set()

// usePermitNoteAutoAnswer backs the permit cards' one-tap answers: an intent
// recorded at decision time resolves the barrier's follow-up ask on arrival,
// typed text as the note and empty as a cancel, so the ask never renders here.
// Suppressed ids name asks being auto-answered, which docks keep off screen
// until the session stops announcing the dialog, a failed resolve drops the
// suppression at once so the ask falls back to hand answering. Without a
// pending intent the ask renders as today, covering dialogs raised elsewhere.
export function usePermitNoteAutoAnswer(
  sessionId: string,
  dialogs: InteractionPending[],
  onAnswered: (dialogId: number) => void,
): {
  suppressed: ReadonlySet<number>
  recordIntent: (answeredId: number, text: string, deny: boolean) => void
} {
  const [suppressed, applySuppression] = useReducer(suppressionReducer, noSuppression)
  const intentsRef = useRef(new Map<number, PermitNoteIntent>())
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const inFlightRef = useRef(new Set<number>())
  // the callback rides a ref, so parent re-renders never rearm the scan
  const answeredRef = useRef(onAnswered)
  useEffect(() => {
    answeredRef.current = onAnswered
  }, [onAnswered])

  // layout effect so suppression lands before the ask can paint a frame
  useLayoutEffect(() => {
    // the text flag confirms the matched dialog really is the note ask, and a
    // secret answer never echoes, so secrets always render for hand answering
    const taken: { id: number; text: string }[] = []
    const live = new Set<number>()
    for (const ask of dialogs) {
      live.add(ask.id)
      if (inFlightRef.current.has(ask.id) || ask.text !== true || ask.secret === true) continue
      const denyAsk = reasonAskDeny(ask.prompt)
      if (denyAsk === undefined) continue
      const text = takeIntent(intentsRef.current, denyAsk)
      if (text !== undefined) taken.push({ id: ask.id, text })
    }
    if (taken.length === 0) {
      applySuppression({ type: 'sync', live })
      return
    }
    applySuppression({ type: 'hide', ids: taken.map((t) => t.id), live })
    for (const { id, text } of taken) {
      inFlightRef.current.add(id)
      // empty text cancels, letting the barrier skip the note entirely
      const body: ResolveAnswer =
        text === '' ? { dialogId: id, cancel: true } : { dialogId: id, text }
      sessions
        .resolve(sessionId, body)
        .then(() => answeredRef.current(id)) // our answer: no answered-elsewhere chip
        .catch((err: unknown) => {
          // settled keeps its benign meaning everywhere, matching the card, the
          // lost race still reads as this surface's answer. Any other failure
          // re-renders the ask for hand answering with the intent spent.
          if (err instanceof ApiError && err.code === 'settled') {
            answeredRef.current(id)
            return
          }
          inFlightRef.current.delete(id)
          applySuppression({ type: 'reveal', id })
        })
        .finally(() => {
          inFlightRef.current.delete(id)
        })
    }
  }, [dialogs, sessionId])

  useEffect(() => {
    // intents never outlive their dock, copies quiet the stale-ref lint
    const intents = intentsRef.current
    const timers = timersRef.current
    const inFlight = inFlightRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      intents.clear()
      inFlight.clear()
    }
  }, [])

  const recordIntent = (answeredId: number, text: string, deny: boolean) => {
    const timer = timersRef.current.get(answeredId)
    if (timer !== undefined) clearTimeout(timer)
    intentsRef.current.set(answeredId, { deny, text: text.trim() })
    timersRef.current.set(
      answeredId,
      setTimeout(() => {
        intentsRef.current.delete(answeredId)
        timersRef.current.delete(answeredId)
      }, intentTtlMs),
    )
  }
  return { suppressed, recordIntent }
}
