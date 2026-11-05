import { useState } from 'react'
import type { ActivityRow } from '../api/types'
import type { ImageView, ToolResultView } from '../state/derive'
import type { ToolProgressView } from '../state/eventApplier'

// ToolCardView is what a card renders: a committed call's info or the live
// shape with its streamed outputs. Live output appends while running; once
// deltas painted the body, result.output adds nothing.
export interface ToolCardView {
  id: string
  name?: string
  input?: unknown
  outputs?: string[]
  progress?: ToolProgressView
  result?: ToolResultView
  verdict?: string // permit outcome riding the card, e.g. 'auto allowed'
  closed?: boolean // the turn ended before a result arrived
}

export function ToolCallCard({
  call,
  agents,
}: {
  call: ToolCardView
  // Sub-agent job rows (sub-N keys): agent_start and agent_poll cards show
  // the queued/running state of every job instead of a bare spinner.
  agents?: ActivityRow[]
}) {
  const [open, setOpen] = useState(false)
  const streamed = (call.outputs ?? []).join('')
  // Deltas already painted the body when present; the committed result only
  // fills a card whose stream nobody rendered. A failed card prefers the
  // upstream fault-location notice over its bare output prefix.
  const images = call.result?.images ?? []
  const failedCard = call.result?.isError === true
  const fault = failedCard ? call.result?.fault : undefined
  let body = streamed !== '' ? streamed : (call.result?.text ?? '')
  if (failedCard && fault !== undefined) body = fault
  const closed = call.closed === true && call.result === undefined
  const done = call.result !== undefined || closed
  const label = call.name || call.progress?.path || call.id

  return (
    <div className={`tool-card ${failedCard ? 'error' : ''}`} data-tool-id={call.id}>
      <button type="button" className="tool-header" onClick={() => setOpen((v) => !v)}>
        <span className="mono">{label}</span>
        {!done && <span className="badge accent">running</span>}
        {done &&
          (failedCard ? (
            <span className="badge danger">failed</span>
          ) : closed ? (
            <span className="badge warn" title="The turn ended before a result arrived">
              no result
            </span>
          ) : (
            <span className="badge ok">done</span>
          ))}
        {call.verdict && <span className="badge">{call.verdict}</span>}
        {body !== '' && !open && <span className="muted tool-preview">{oneLine(body)}</span>}
      </button>
      {(call.input !== undefined || open) && (
        <div className="tool-body">
          {call.input !== undefined && <pre className="mono muted">{inputPreview(call.input)}</pre>}
          {open && body !== '' && <pre className="mono">{body}</pre>}
          {images.map((img, i) => (
            <ToolImage key={i} image={img} />
          ))}
        </div>
      )}
      {!done && agents !== undefined && agents.length > 0 && <SubAgentState rows={agents} />}
    </div>
  )
}

// SubAgentState lists each sub-agent job's own state line, so queued work is
// visible before it starts and progress replaces a generic spinner. Upstream
// rows run long (~2048 runes): CSS clamps them to one line and title keeps
// the full text on hover.
function SubAgentState({ rows }: { rows: ActivityRow[] }) {
  return (
    <div className="subagent-state" aria-label="Sub-agent jobs">
      {rows.map((row) => (
        <span
          key={row.key}
          className="badge sub-agent-chip"
          data-sub-key={row.key}
          title={row.text}
        >
          {row.text}
        </span>
      ))}
    </div>
  )
}

// SubAgentChips renders the live chips above the streaming block; rows come
// from the snapshot's activity family (sub-N keys), removed when jobs end.
export function SubAgentChips({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="subagent-chips" aria-label="Sub-agents">
      <SubAgentState rows={rows} />
    </div>
  )
}

function ToolImage({ image }: { image: ImageView }) {
  if (image.data === undefined) {
    return (
      <div className="muted" data-testid="deferred-image">
        [image {image.mediaType} not loaded]
      </div>
    )
  }
  // Bodies are base64 media the transcript already vetted as an image type.
  return <img alt="" src={`data:${image.mediaType};base64,${image.data}`} className="entry-image" />
}

function inputPreview(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function oneLine(text: string): string {
  const first = text.trimStart().split('\n')[0] ?? ''
  return first.length > 80 ? first.slice(0, 79) + '…' : first
}
