import { useMemo, useState } from 'react'
import type { ActivityRow } from '../api/types'
import type { ImageView, ToolResultView } from '../state/derive'
import type { ToolProgressView } from '../state/eventApplier'

import { EditOpDiff, splitRows } from './DiffCard'
import { parseEditInput } from './editInput'

// ToolCardView is what a card renders: a committed call's info or the live
// shape with its streamed outputs. Live output appends while running; once
// deltas painted the body, result.output adds nothing.
interface ToolCardView {
  id: string
  name?: string
  label?: string // header text overriding the tool name ('! cmd' on shell cards)
  input?: unknown
  outputs?: string[]
  progress?: ToolProgressView
  result?: ToolResultView
  verdict?: string // permit outcome riding the card, e.g. 'auto allowed'
  closed?: boolean // the turn ended before a result arrived
}

// Bodies past this many lines collapse behind the header's line count instead
// of a first-line preview
const longBodyLines = 30

export function ToolCallCard({
  call,
  agents,
}: {
  call: ToolCardView
  // Sub-agent job rows (sub-N keys): agent_start and agent_poll cards show
  // the queued/running state of every job while any row is live.
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
  const label = call.label || call.name || call.progress?.path || call.id
  const bodyLines = body === '' ? 0 : splitRows(body).length
  // Only a body nobody watched stream collapses behind a count: a streamed
  // body keeps its live first-line preview
  const counted = streamed === '' && bodyLines > longBodyLines

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
        {body !== '' && !open && (
          <span className="muted tool-preview">
            {counted ? `Output · ${bodyLines} lines` : oneLine(body)}
          </span>
        )}
      </button>
      {(call.input !== undefined || open) && (
        <div className="tool-body">
          {call.input !== undefined && <ToolInputView name={call.name} input={call.input} />}
          {open && body !== '' && <pre className="mono">{body}</pre>}
          {images.map((img, i) => (
            <ToolImage key={i} image={img} />
          ))}
        </div>
      )}
      {agents !== undefined && agents.length > 0 && <SubAgentState rows={agents} />}
    </div>
  )
}

// ToolInputView renders a call's arguments: edit calls as one diff per op,
// every other shape pretty-printed. Unparseable edit input pretty-prints with
// the rest rather than risking a half-read diff.
function ToolInputView({ name, input }: { name?: string; input: unknown }) {
  // Memoized on the input's identity, which the applier preserves across
  // events, so live streaming never rediffs a settled call per frame.
  const edit = useMemo(() => (name === 'edit' ? parseEditInput(input) : undefined), [name, input])
  if (edit !== undefined) {
    return (
      <div className="edit-input">
        <div className="diff-path mono">
          {edit.path}
          {edit.ops.length > 1 ? ` · ${edit.ops.length} edits` : ''}
        </div>
        {edit.ops.map((op, i) => (
          <EditOpDiff key={i} op={op} />
        ))}
      </div>
    )
  }
  return <pre className="mono muted">{prettyInput(input)}</pre>
}

// SubAgentState lists each sub-agent job's own state line, so queued work is
// visible before it starts and progress replaces a generic spinner. Rows live
// only while their job does: a poll timeout result lands while siblings still
// run, so chips stay put until each row clears upstream instead of vanishing
// with the card's own result. Upstream rows run long (~2048 runes): CSS clamps
// them to one line and title keeps the full text on hover.
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

// prettyInput renders arguments readably: strings verbatim, objects and arrays
// two-space indented. A value JSON cannot express (cyclic) degrades to String.
function prettyInput(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    const text = JSON.stringify(input, null, 2)
    return text === undefined ? String(input) : text
  } catch {
    return String(input)
  }
}

function oneLine(text: string): string {
  const first = text.trimStart().split('\n')[0] ?? ''
  return first.length > 80 ? first.slice(0, 79) + '…' : first
}
