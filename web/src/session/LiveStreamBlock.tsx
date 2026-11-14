import { useLayoutEffect, useRef } from 'react'

import { barrierHold } from './barrierHold'
import { MarkdownBlock } from './MarkdownBlock'
import { ToolCallCard, SubAgentChips } from './ToolCallCard'
import { capRows, subAgentRows } from './subAgents'
import { useRafThrottled } from '../hooks/useRafThrottled'
import type { AgentJobs } from './useAgentJobs'
import type { LiveTurn } from '../state/eventApplier'
import type { ActivityRow } from '../api/types'
import type { ToolResultView } from '../state/derive'

// LiveStreamBlock is the pinned streaming row: one in-flight turn fed by
// rAF-batched buffers so transcript rows never re-render per delta. It paints
// through the same markdown pipeline the committed entry will, so the handoff
// at turn end swaps nothing visibly. Sub-agent jobs stream as live chips above
// it, the one full list, a waiting poll card shows its own job's state line.
// agentJobs carries the pull listing: record status, elapsed and stop.
// While a dialog holds the turn, calls queued behind the gated one wait (see
// barrierHold) so the dialog's answer reads against that one action, and the
// gated edit card itself drops its op preview: the full-file diff rides above
// the dialog, a fragment-numbered copy would only misread against it.
export function LiveStreamBlock({
  live,
  activity,
  agentJobs,
  dialogOpen = false, // an open dialog holds the turn at the gated call
  onThinkingToggle,
}: {
  live: LiveTurn
  activity?: ActivityRow[]
  agentJobs?: AgentJobs
  dialogOpen?: boolean
  // Reports each manual panel toggle's post-click state so the applier can
  // stop applying programmatic collapses.
  onThinkingToggle: (open: boolean) => void
}) {
  const current = useRafThrottled(live)
  const held = barrierHold(current.tools, dialogOpen)
  const subs = subAgentRows(activity)
  const chips = capRows(subs)
  return (
    <div className="live-block" aria-label="Live stream">
      <span className="block-role">live{current.model ? ` · ${current.model}` : ''}</span>
      <SubAgentChips rows={chips.rows} overflow={chips.overflow} jobs={agentJobs} />
      {current.thinking !== '' && (
        <LiveThinking
          text={current.thinking}
          open={current.thinkingOpen}
          onUserToggle={onThinkingToggle}
        />
      )}
      {current.text !== '' && <MarkdownBlock text={current.text} />}
      {held.shown.map((tool) => (
        <LiveToolCard
          key={tool.id}
          tool={tool}
          agents={subs}
          agentJobs={agentJobs}
          gated={tool.id === held.gatedId}
        />
      ))}
      {held.held > 0 && (
        <p className="held-calls">
          +{held.held} tool {held.held === 1 ? 'call' : 'calls'} held until the dialog is answered
        </p>
      )}
    </div>
  )
}

// LiveThinking renders the panel uncontrolled: manual toggles survive every
// render, and only a flip of the applier's intent is written through (mount
// seeding, end-of-thinking collapse), so React never rewrites a value the
// user clicked. The click event lands before the native toggle's default
// action, which is why the reported state is the pre-click value inverted.
function LiveThinking({
  text,
  open,
  onUserToggle,
}: {
  text: string
  open: boolean
  onUserToggle?: (open: boolean) => void
}) {
  const ref = useRef<HTMLDetailsElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (el && el.open !== open) el.open = open
  }, [open])

  return (
    <details ref={ref} className="thinking">
      <summary onClick={() => onUserToggle?.(!(ref.current?.open ?? false))}>thinking…</summary>
      <div className="muted thinking-text">{text}</div>
    </details>
  )
}

function LiveToolCard({
  tool,
  agents,
  agentJobs,
  gated = false,
}: {
  tool: LiveTurn['tools'][number]
  agents: ActivityRow[]
  agentJobs?: AgentJobs
  gated?: boolean
}) {
  const result: ToolResultView | undefined = tool.result
    ? {
        callId: tool.id,
        text: tool.result.output,
        images: [],
        isError: tool.result.error,
        fault: tool.result.fault,
      }
    : undefined
  return (
    <ToolCallCard
      call={{
        id: tool.id,
        name: tool.name || undefined,
        label: tool.label,
        shell: tool.shell,
        excluded: tool.excluded,
        input: tool.input,
        outputs: tool.outputs,
        progress: tool.progress,
        result,
        verdict: tool.verdict,
        closed: tool.closed,
      }}
      agents={agents}
      agentJobs={agentJobs}
      gated={gated}
    />
  )
}
