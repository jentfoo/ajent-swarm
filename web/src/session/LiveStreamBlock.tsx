import { useLayoutEffect, useRef } from 'react'

import { MarkdownBlock } from './MarkdownBlock'
import { ToolCallCard, SubAgentChips } from './ToolCallCard'
import { subAgentRows } from './StatusBar'
import { useRafThrottled } from '../hooks/useRafThrottled'
import type { LiveTurn } from '../state/eventApplier'
import type { ActivityRow } from '../api/types'
import type { ToolResultView } from '../state/derive'

// LiveStreamBlock is the pinned streaming row: one in-flight turn fed by
// rAF-batched buffers so transcript rows never re-render per delta. It paints
// through the same markdown pipeline the committed entry will, so the handoff
// at turn end swaps nothing visibly. Sub-agent jobs stream as live chips
// above it; agent tool cards show job state instead of a bare spinner.
export function LiveStreamBlock({
  live,
  activity,
  onThinkingToggle,
}: {
  live: LiveTurn
  activity?: ActivityRow[]
  // Reports each manual panel toggle's post-click state so the applier can
  // stop applying programmatic collapses; absent leaves toggles view-local.
  onThinkingToggle?: (open: boolean) => void
}) {
  const current = useRafThrottled(live)
  const subs = subAgentRows(activity)
  return (
    <div className="live-block" aria-label="Live stream">
      <span className="block-role">live{current.model ? ` · ${current.model}` : ''}</span>
      {subs.length > 0 && <SubAgentChips rows={subs} />}
      {current.thinking !== '' && (
        <LiveThinking
          text={current.thinking}
          open={current.thinkingOpen}
          onUserToggle={onThinkingToggle}
        />
      )}
      {current.text !== '' && <MarkdownBlock text={current.text} />}
      {current.tools.map((tool) => (
        <LiveToolCard key={tool.id} tool={tool} agents={subs} />
      ))}
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

// isAgentTool names the calls that drive sub-agent batches; their cards
// render every job's state while they run.
function isAgentTool(name: string): boolean {
  return name === 'agent_start' || name === 'agent_poll'
}

function LiveToolCard({
  tool,
  agents,
}: {
  tool: LiveTurn['tools'][number]
  agents?: ActivityRow[]
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
        input: tool.input,
        outputs: tool.outputs,
        progress: tool.progress,
        result,
        closed: tool.closed,
      }}
      running={tool.result === undefined && !tool.closed}
      agents={isAgentTool(tool.name) ? agents : undefined}
    />
  )
}
