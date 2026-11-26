import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import type { Entry } from '../api/types'
import type { AppliedSessionState } from '../state/eventApplier'
import { deriveBlocks } from '../state/derive'
import type { DerivedBlock } from '../state/derive'

// announceMaxChars bounds the read-out, so a long reply never floods the listener
const announceMaxChars = 120

// TurnRead is one render's reading of a session: seq tells a wire event from a
// rebuilt state, len and tail fence the append window, running marks the turn
// and pending carries the newest answer committed while it ran.
interface TurnRead {
  seq: number
  len: number
  tail: string | undefined
  running: boolean
  pending: string
}

type AssistantBlock = Extract<DerivedBlock, { kind: 'assistant' }>

// TurnEndAnnouncement is the polite status line both session surfaces mount:
// silent until a streamed turn retires, then "Assistant replied" plus the
// first non-empty line of the answer that turn committed, cut to about 120
// characters. Streaming never announces, and neither does mounting over
// history, a rebuilt state, an older-history prepend or a rewind: only a reply
// committed at the chain tail by a wire event counts. A new turn clears the
// line, so two equal replies still read twice. Hosts key on sessionId, so a
// session swap is a remount and reads as history.
export function TurnEndAnnouncement({ state }: { state: AppliedSessionState }): ReactElement {
  const [announce, setAnnounce] = useState('')
  const last = useRef(readOf(state))

  useEffect(() => {
    const before = last.current
    const running = state.snapshot.running
    // only a wire event commits a reply, an init rebuilds the chain as history
    const evented = state.seq > before.seq
    const fresh = evented ? committedReply(appendedIds(before, state.chain.ids), state.entries) : ''
    let pending = before.pending
    if (running && !before.running) pending = '' // a new turn commits nothing yet
    if (fresh !== '') pending = fresh
    // retired: the turn this view watched ended, or a reply landed with no turn
    // in flight (right after turn.end, or a whole turn between two renders). An
    // exit's ended banner speaks for its cut turn instead
    const retired = !running && (before.running || fresh !== '')
    if (retired && pending !== '' && state.exitReason === undefined) {
      setAnnounce(`Assistant replied: ${excerpt(pending)}`)
      pending = ''
    } else if (running && !before.running) {
      setAnnounce('') // the line clears per turn, so an equal reply reads again
    }
    last.current = readOf(state, pending)
  }, [state])

  return (
    <span className="sr-only" role="status">
      {announce}
    </span>
  )
}

// readOf takes one render's reading, pending the answer the running turn has
// committed so far ('' until one lands)
function readOf(state: AppliedSessionState, pending = ''): TurnRead {
  const ids = state.chain.ids
  return {
    seq: state.seq,
    len: ids.length,
    tail: ids.at(-1),
    running: state.snapshot.running,
    pending,
  }
}

// appendedIds lists the chain ids committed since the last read. The previous
// tail must still sit at its index, so an older-history prepend, a rewind or
// any rebuilt branch reads as no reply rather than a fresh one.
function appendedIds(before: TurnRead, ids: readonly string[]): string[] {
  if (ids.length <= before.len || ids[before.len - 1] !== before.tail) return []
  return ids.slice(before.len)
}

// committedReply is the newest assistant text among the entries committed in
// one append window; a step that only called tools answers nothing.
function committedReply(ids: readonly string[], entries: Map<string, Entry>): string {
  const reply = deriveBlocks(ids, entries).findLast(
    (block): block is AssistantBlock =>
      block.kind === 'assistant' && block.parts.some((part) => part.kind === 'text'),
  )
  if (reply === undefined) return ''
  return reply.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n')
}

// excerpt is a reply's first non-empty line, trimmed and cut to the bound
function excerpt(text: string): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  const chars = Array.from(line)
  return chars.length > announceMaxChars ? `${chars.slice(0, announceMaxChars).join('')}…` : line
}
