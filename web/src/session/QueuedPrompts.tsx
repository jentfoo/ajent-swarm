import { shortID } from './names'
import type { DroppedQueueRow, PendingSubmit } from '../state/eventApplier'
import type { QueueRow } from '../api/types'

// QueuedPrompts renders queue management as chips at all times: the wire's
// rows beside this client's optimistic ones, secret rows redacted to their id,
// and recently dropped rows badged with why they left (interrupt, rewind or
// recalled). Editing goes through recall in the composer; since the wire's
// recall always pops the newest row, only that chip offers it.
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
  if (queuedRows.length === 0 && pendings.length === 0 && droppedRows.length === 0) return null

  return (
    <div className="chips" aria-label="Queued prompts">
      {queuedRows.map((row, i) => (
        <QueueChip
          key={row.id}
          id={row.id}
          text={row.text}
          // the wire's recall pops the newest row; older chips cannot edit yet
          editable={i === queuedRows.length - 1}
          onEdit={onEdit}
        />
      ))}
      {/* Optimistic rows the wire has not named yet stay visible while pending */}
      {pendings
        .filter((p) => p.state === 'pending' && !queuedRows.some((r) => r.id === p.id))
        .map((p) => (
          <QueueChip key={p.id} id={p.id} text={p.text} state="pending" />
        ))}
      {pendings
        .filter((p) => p.state === 'failed')
        .map((p) => (
          <QueueChip key={p.id} id={p.id} text={p.text} state="failed" />
        ))}
      {droppedRows.map((row) => (
        <QueueChip key={`dropped-${row.id}`} id={row.id} text={row.text} cause={row.cause} />
      ))}
    </div>
  )
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
