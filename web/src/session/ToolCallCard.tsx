import { useMemo, useState } from 'react'
import type { ActivityRow } from '../api/types'
import type { ImageView, ToolResultView } from '../state/derive'
import { isRenderableImage } from '../state/derive'
import type { ToolProgressView } from '../state/eventApplier'

import { CopyButton } from './CopyButton'
import { EditOpDiff, splitRows } from './DiffCard'
import { parseEditInput } from './editInput'
import { progressText } from './progressText'
import { agentJobStatusClass, cardSubAgentRow, formatElapsed, stoppableJob } from './subAgents'
import { prettyInput, unquoteJSON } from './toolInput'
import type { AgentJobs } from './useAgentJobs'

// ToolCardView is what a card renders: a committed call's info or the live
// shape with its streamed outputs. Live output appends while running, once
// deltas painted the body, result.output adds nothing.
interface ToolCardView {
  id: string
  name?: string
  label?: string // header text overriding the tool name ('! cmd' on shell cards)
  shell?: boolean // a staged user `!`/`!!` run, body open while streaming
  excluded?: boolean // the `!!` kind: its output never reaches the model
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

// Argument keys per tool word, tried in order. The word is looked up from the
// tool name's own parts, so bash, Bash, read_file and repo_search all resolve
// while a name without a known word renders the tool name alone.
const summaryKeys = new Map<string, readonly string[]>([
  ['bash', ['command', 'cmd']],
  ['shell', ['command', 'cmd']],
  ['edit', ['path']],
  ['read', ['path']],
  ['write', ['path']],
  ['ls', ['path']],
  ['grep', ['pattern', 'query']],
  ['search', ['pattern', 'query']],
  ['find', ['pattern']],
  ['glob', ['pattern']],
])

export function ToolCallCard({
  call,
  agents,
  agentJobs,
  gated = false,
}: {
  call: ToolCardView
  // Live sub-agent rows (sub-N keys): an agent_poll card renders the one job
  // it waits on until its result lands, every other call renders none.
  agents?: ActivityRow[]
  // The pull listing behind the job surfaces: per-job status and elapsed
  // plus the stop control on the poll card's own row. Absent (committed
  // history, unwired sessions) renders the row text alone.
  agentJobs?: AgentJobs
  // An open dialog gates this call: the full-file diff rides above the dialog,
  // so the edit preview stands down instead of repeating it fragment-numbered
  gated?: boolean
}) {
  const ownJob = cardSubAgentRow(call, agents ?? [])
  const streamed = (call.outputs ?? []).join('')
  // Deltas already painted the body when present, the committed result only
  // fills a card whose stream nobody rendered. A failed card prefers the
  // upstream fault-location notice over its bare output prefix.
  const images = call.result?.images ?? []
  const failedCard = call.result?.isError === true
  const fault = failedCard ? call.result?.fault : undefined
  let body = streamed !== '' ? streamed : (call.result?.text ?? '')
  if (failedCard && fault !== undefined) body = fault
  const closed = call.closed === true && call.result === undefined
  const done = call.result !== undefined || closed
  // a staged run paints whole while streaming and collapses once done, until
  // the user owns the toggle, other cards stay manual-only
  const streaming = call.shell === true && !done
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? streaming
  const shellCard = call.shell === true
  const excludedCard = shellCard && call.excluded === true
  // While the model is still composing this call's arguments (before tool.start
  // delivers full input) the header carries its streamed size, matching
  // upstream's TUI activity row. The done frame or the start takes over from here.
  const compose = !done && call.input === undefined ? progressText(call.progress ?? {}) : ''
  const label = call.label || call.name || call.progress?.path || call.id
  // a shell card's label already is its command
  const summary = shellCard ? undefined : toolSummary(call.name, call.input)
  const bodyLines = body === '' ? 0 : splitRows(body).length
  // Only a body nobody watched stream collapses behind a count: a streamed
  // body keeps its live first-line preview, and a fault keeps its head since
  // it names what went wrong
  const counted = streamed === '' && !failedCard && bodyLines > longBodyLines

  return (
    <div
      className={`tool-card${shellCard ? ' shell' : ''}${excludedCard ? ' excluded' : ''}${
        failedCard ? ' error' : ''
      }`}
      data-tool-id={call.id}
    >
      <button
        type="button"
        className="tool-header"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        <span className="mono">{label}</span>
        {summary !== undefined && <span className="mono muted tool-summary">{summary}</span>}
        {!done && <span className="badge accent">running</span>}
        {done &&
          (failedCard ? (
            <span className="badge danger">failed</span>
          ) : closed ? (
            <span className="badge warn" title="The turn ended before a result arrived">
              no result
            </span>
          ) : excludedCard ? (
            <span className="badge danger">output not sent to the model</span>
          ) : shellCard ? (
            <span className="badge warn">staged - rides your next message</span>
          ) : (
            <span className="badge ok">done</span>
          ))}
        {call.verdict && <span className="badge">{call.verdict}</span>}
        {compose !== '' && <span className="muted tool-preview">{compose}</span>}
        {body !== '' && !open && (
          <span className="muted tool-preview">
            {counted ? `Output · ${bodyLines} lines` : oneLine(body)}
          </span>
        )}
      </button>
      {open && (
        <div className="tool-body">
          {call.input !== undefined && (
            <ToolInputView name={call.name} input={call.input} gated={gated} />
          )}
          {body !== '' && (
            <>
              <div className="tool-body-bar">
                <CopyButton text={body} className="tool-copy" />
              </div>
              <pre className="mono">{body}</pre>
            </>
          )}
          {images.map((img, i) => (
            <ToolImage key={i} image={img} />
          ))}
        </div>
      )}
      {ownJob !== undefined && <SubAgentState rows={[ownJob]} jobs={agentJobs} />}
    </div>
  )
}

// ToolInputView renders a call's arguments: edit calls as one unnumbered diff
// per op (nothing on the wire says where an op sat in the file), every other
// shape pretty-printed. Unparseable edit input pretty-prints with the rest
// rather than risking a half-read diff. A gated edit drops its op diffs:
// upstream commits the full-file diff before the ask, so the preview would
// only repeat it.
function ToolInputView({
  name,
  input,
  gated = false,
}: {
  name?: string
  input: unknown
  gated?: boolean
}) {
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
        {!gated && edit.ops.map((op, i) => <EditOpDiff key={i} op={op} />)}
      </div>
    )
  }
  return <pre className="mono muted">{prettyInput(input)}</pre>
}

// SubAgentState lists each sub-agent job's own state line, so queued work is
// visible before it starts and progress replaces a generic spinner. The band
// keeps every row until upstream clears it, matching row lifetimes: one
// card's result never removes a sibling's line. Upstream rows run long
// (~2048 runes): CSS clamps them to one line and title keeps the full text
// on hover. Overflow folds the newest jobs under a "+N more" line. The pull
// listing adds the record-owned status and elapsed beside the live line and
// the stop control on queued and running jobs.
function SubAgentState({
  rows,
  overflow = 0,
  jobs,
}: {
  rows: ActivityRow[]
  overflow?: number
  jobs?: AgentJobs
}) {
  return (
    <div className="subagent-state" aria-label="Sub-agent jobs">
      {rows.map((row) => (
        <SubAgentJob key={row.key} row={row} jobs={jobs} />
      ))}
      {overflow > 0 && (
        <span className="badge sub-agent-chip" title={`${overflow} newer jobs hidden`}>
          +{overflow} more
        </span>
      )}
    </div>
  )
}

// SubAgentJob is one job's chip: the row's live line, the record's status and
// elapsed beside it, and a stop button while the job can still cancel. A
// hidden surface (no listing, unwired session) renders the row text alone.
function SubAgentJob({ row, jobs }: { row: ActivityRow; jobs?: AgentJobs }) {
  const listed = jobs?.available === true
  const job = listed ? jobs?.byId.get(row.key) : undefined
  const title = [row.text, job?.task].filter(Boolean).join('\n')
  return (
    <span className="sub-agent-job">
      <span className="badge sub-agent-chip" data-sub-key={row.key} title={title}>
        {row.text}
      </span>
      {job !== undefined && (
        <span className={`badge ${agentJobStatusClass(job.status)}`} data-sub-status={job.status}>
          {job.status}
        </span>
      )}
      {job?.elapsedMs !== undefined && (
        <span className="badge muted">{formatElapsed(job.elapsedMs)}</span>
      )}
      {listed && stoppableJob(job) && (
        <button
          type="button"
          className="sub-agent-stop"
          aria-label={`Stop ${row.key}`}
          disabled={jobs?.stopping}
          onClick={() => jobs?.stop(row.key)}
        >
          stop
        </button>
      )}
    </span>
  )
}

// SubAgentChips renders the live chips above the streaming block: the single
// full list of jobs, capped like upstream's band with the overflow line.
export function SubAgentChips({
  rows,
  overflow,
  jobs,
}: {
  rows: ActivityRow[]
  overflow: number
  jobs?: AgentJobs
}) {
  if (rows.length === 0) return null
  return (
    <div className="subagent-chips" aria-label="Sub-agents">
      <SubAgentState rows={rows} overflow={overflow} jobs={jobs} />
    </div>
  )
}

function ToolImage({ image }: { image: ImageView }) {
  // The allowlist keeps hostile media types out of an img src.
  if (image.data === undefined || !isRenderableImage(image.mediaType)) {
    return (
      <div className="muted" data-testid="deferred-image">
        [image {image.mediaType} not loaded]
      </div>
    )
  }
  // Bodies are base64 media whose type passed the render allowlist.
  return <img alt="" src={`data:${image.mediaType};base64,${image.data}`} className="entry-image" />
}

// toolSummary is the header's one-line digest of what a call does: the shell
// command, the path a read, write or edit touches, the grep or search
// pattern. Best-effort on known tool words and argument keys, undefined
// whenever nothing is recognized so the tool name stands alone.
function toolSummary(name: string | undefined, input: unknown): string | undefined {
  const keys = name
    ?.toLowerCase()
    .split(/[^a-z]+/)
    .map((word) => summaryKeys.get(word))
    .find((found) => found !== undefined)
  if (keys === undefined) return undefined
  const args = unquoteJSON(input)
  // a bare string is the argument itself, how some models send a command
  if (typeof args === 'string') return summaryText(args)
  if (typeof args !== 'object' || args === null) return undefined
  const fields = args as Record<string, unknown>
  for (const key of keys) {
    const value = fields[key]
    if (typeof value !== 'string') continue
    const text = summaryText(value)
    if (text !== undefined) return text
  }
  return undefined
}

// summaryText keeps a value's first line for the header, undefined when the
// value is blank
function summaryText(value: string): string | undefined {
  const line = oneLine(value)
  return line === '' ? undefined : line
}

function oneLine(text: string): string {
  const first = text.trimStart().split('\n')[0]
  return first.length > 80 ? first.slice(0, 79) + '…' : first
}
