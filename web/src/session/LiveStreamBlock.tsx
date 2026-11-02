import { MarkdownBlock } from './MarkdownBlock'
import { ToolCallCard } from './ToolCallCard'
import { useRafThrottled } from '../hooks/useRafThrottled'
import type { LiveTurn } from '../state/eventApplier'
import type { ToolResultView } from '../state/derive'

// LiveStreamBlock is the pinned streaming row: one in-flight turn fed by
// rAF-batched buffers so transcript rows never re-render per delta. It paints
// through the same markdown pipeline the committed entry will, so the handoff
// at turn end swaps nothing visibly.
export function LiveStreamBlock({ live }: { live: LiveTurn }) {
  const current = useRafThrottled(live)
  return (
    <div className="live-block" aria-label="Live stream">
      <span className="block-role">live{current.model ? ` · ${current.model}` : ''}</span>
      {current.thinking !== '' && (
        <details className="thinking" open={current.thinkingOpen}>
          <summary>thinking…</summary>
          <div className="muted">{current.thinking}</div>
        </details>
      )}
      {current.text !== '' && <MarkdownBlock text={current.text} />}
      {current.tools.map((tool) => (
        <LiveToolCard key={tool.id} tool={tool} />
      ))}
    </div>
  )
}

function LiveToolCard({ tool }: { tool: LiveTurn['tools'][number] }) {
  const result: ToolResultView | undefined = tool.result
    ? { callId: tool.id, text: tool.result.output, images: [], isError: tool.result.error }
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
      }}
      running={tool.result === undefined}
    />
  )
}
