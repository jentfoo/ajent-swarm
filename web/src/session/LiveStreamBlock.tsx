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
export function LiveStreamBlock({ live, activity }: { live: LiveTurn; activity?: ActivityRow[] }) {
  const current = useRafThrottled(live)
  const subs = subAgentRows(activity)
  return (
    <div className="live-block" aria-label="Live stream">
      <span className="block-role">live{current.model ? ` · ${current.model}` : ''}</span>
      {subs.length > 0 && <SubAgentChips rows={subs} />}
      {current.thinking !== '' && (
        <details className="thinking" open={current.thinkingOpen}>
          <summary>thinking…</summary>
          <div className="muted thinking-text">{current.thinking}</div>
        </details>
      )}
      {current.text !== '' && <MarkdownBlock text={current.text} />}
      {current.tools.map((tool) => (
        <LiveToolCard key={tool.id} tool={tool} agents={subs} />
      ))}
    </div>
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
