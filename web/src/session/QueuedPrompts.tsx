import { useEffect, useState } from 'react'

import { shortID } from './names'
import type { DroppedQueueRow, PendingSubmit } from '../state/eventApplier'
import type { QueueRow } from '../api/types'

// maxChips bounds the queue area to four visible rows plus one overflow line,
// ajent's TUI input cap during submit bursts.
const maxChips = 4

// refusedTtlMs mirrors Notices' expiry: a refusal keeps its chip for this long
// after failing, then the render drops it, so repeat failures age out.
const refusedTtlMs = 8_000

// QueuedPrompts renders queue management as chips: the wire's rows beside this
// client's optimistic ones, secret rows redacted to their id, and recently
// dropped rows badged with why they left (interrupt, rewind or recalled). The
// rows form one chronological list capped at maxChips keeping the newest end,
// where the recall affordance and live submit feedback sit, older rows
// collapsing into one "+N more" line. Editing goes through recall in the
// composer, since the wire's recall always pops the newest row, only that chip
// offers it. Refused submits expire refusedTtlMs after their refusal.
// Fresh refusals also announce through one sr-only polite region, so a failed
// submit is heard without every queue chip being read aloud.
export function QueuedPrompts({
  queuedRows,
  pendings,
  droppedRows,
  onEdit,
}: {
  queuedRows: QueueRow[]
  pendings: PendingSubmit[]
  droppedRows: DroppedQueueRow[]
  onEdit: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  // tick only while a refused chip is fresh: expired rows stay in store state
  // forever, so gating on freshness keeps the timer from running for nothing
  const freshRefused = pendings.some((p) => refusedVisible(p, now))
  useEffect(() => {
    if (!freshRefused) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [freshRefused])

  // dropped rows are former queue contents, then the wire queue oldest first,
  // then this client's in-flight submits, one order so the cap keeps the
  // newest end
  const named = new Set(queuedRows.map((row) => row.id))
  const chips = [
    ...droppedRows.map((row) => (
      <QueueChip key={`dropped-${row.id}`} id={row.id} text={row.text} cause={row.cause} />
    )),
    ...queuedRows.map((row, i) => (
      <QueueChip
        key={row.id}
        id={row.id}
        text={row.text}
        // the wire's recall pops the newest row, older chips cannot edit yet
        editable={i === queuedRows.length - 1}
        onEdit={onEdit}
      />
    )),
    // optimistic rows the wire has not named yet stay visible, failed ones
    // only while fresh
    ...pendings.flatMap((p) => {
      if (p.state !== 'pending' && p.state !== 'failed') return []
      if (p.state === 'pending' && named.has(p.id)) return []
      if (p.state === 'failed' && !refusedVisible(p, now)) return []
      return [<QueueChip key={p.id} id={p.id} text={p.text} state={p.state} />]
    }),
  ]
  if (chips.length === 0) return null

  const overflow = chips.length - maxChips
  return (
    <div className="chips" aria-label="Queued prompts">
      {/* mounted with the band so a refusal mutates live-region content */}
      <span className="sr-only" aria-live="polite">
        {refusalAnnouncement(pendings, now)}
      </span>
      {overflow > 0 && <span className="queue-more">+{overflow} more</span>}
      {chips.slice(-maxChips)}
    </div>
  )
}

// refusedVisible reports whether a failed row still shows its refusal chip
// an absent stamp reads as expired.
function refusedVisible(p: PendingSubmit, now: number): boolean {
  return p.state === 'failed' && now - (p.failedAt ?? 0) < refusedTtlMs
}

// refusalAnnouncement summarizes the fresh failed rows as one polite line,
// stable across renders while the same set is fresh so nothing re-announces.
// Secrets read by their id, matching the chip's own redaction.
function refusalAnnouncement(pendings: PendingSubmit[], now: number): string {
  const refused = pendings.filter((p) => refusedVisible(p, now))
  if (refused.length === 0) return ''
  if (refused.length > 1) return `${refused.length} prompts refused`
  const row = refused[0]
  return `Prompt refused: ${row.text === '' ? `secret prompt ${shortID(row.id)}` : row.text}`
}

function QueueChip({
  id,
  text,
  state,
  cause,
  editable,
  onEdit,
}: {
  id: string
  text: string
  state?: 'pending' | 'failed'
  cause?: string
  editable?: boolean
  onEdit?: () => void
}) {
  const classes = ['queue-chip', 'mono']
  if (state === 'failed') classes.push('failed')
  if (cause !== undefined) classes.push('dropped')
  return (
    <span className={classes.join(' ')}>
      {text === '' ? `secret prompt ${shortID(id)}` : text}
      {state === 'pending' && <span className="badge accent">sending…</span>}
      {state === 'failed' && <span className="badge danger">refused</span>}
      {cause !== undefined && <span className="badge warn">{cause}</span>}
      {editable && (
        <button
          type="button"
          title="Edit through recall: pops this prompt back into the composer"
          onClick={onEdit}
        >
          ✎ edit
        </button>
      )}
    </span>
  )
}
