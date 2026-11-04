import * as React from 'react'

import { MarkdownBlock } from './MarkdownBlock'
import { ToolCallCard } from './ToolCallCard'
import type { ToolCardView } from './ToolCallCard'
import type { DerivedBlock, ImageView, ToolResultView } from '../state/derive'

// EntryBlocks renders one committed entry's derived block. Memoized on the
// block object itself: derivation rebuilds only when the chain changes, so a
// streaming turn never re-renders settled history.
export const EntryBlock = React.memo(EntryBlockImpl)

function EntryBlockImpl({ block }: { block: DerivedBlock }) {
  switch (block.kind) {
    case 'prompt':
      return (
        <div className="entry prompt" data-entry-id={block.id}>
          <span className="block-role">prompt</span>
          <MarkdownBlock text={block.text} />
          <ImageRow images={block.images} />
        </div>
      )
    case 'injected':
      return (
        <div className="entry injected" data-entry-id={block.id}>
          <span className="block-role">context · replayed into the model</span>
          <MarkdownBlock text={block.text} />
        </div>
      )
    case 'assistant':
      return (
        <div className="entry assistant" data-entry-id={block.id}>
          <span className="block-role">
            assistant
            {block.stop && block.stop !== 'end_turn' ? ` · stop: ${block.stop}` : ''}
          </span>
          {block.thinking.length > 0 && (
            <details className="thinking">
              <summary>thinking…</summary>
              {block.thinking.map((text, i) => (
                <div key={i} className="muted thinking-text">
                  {text}
                </div>
              ))}
            </details>
          )}
          {block.parts.map((part, i) =>
            part.kind === 'text' ? (
              <MarkdownBlock key={`text-${i}`} text={part.text} />
            ) : (
              <ToolCallCard key={part.call.id} call={committedView(part.call)} />
            ),
          )}
        </div>
      )
    case 'tool-results':
      return (
        <div className="entry carrier" data-entry-id={block.id}>
          {block.results.map((r, i) => (
            <ToolCallCard
              key={`${r.callId}-${i}`}
              call={{ id: r.callId, name: r.toolName, result: r }}
            />
          ))}
        </div>
      )
    case 'system': {
      const d = (block.entry.data ?? {}) as Record<string, unknown>
      return (
        <div className="entry system" data-entry-id={block.id}>
          <span className="badge">{systemText(block.entry.type, d)}</span>
        </div>
      )
    }
    case 'compaction':
      return (
        <div className="entry compaction-divider" data-entry-id={block.id} role="separator">
          — context compacted —
        </div>
      )
    case 'notice':
      return (
        <div className={`block-notice ${block.level}`} data-entry-id={block.id}>
          {block.text}
        </div>
      )
    case 'unknown':
      return (
        <div className="entry unknown muted mono" data-entry-id={block.id}>
          [{block.type}]
        </div>
      )
  }
}

function committedView(call: {
  id: string
  name: string
  input?: unknown
  result?: ToolResultView
}): ToolCardView {
  return { id: call.id, name: call.name, input: call.input, result: call.result }
}

// ImageRow renders prompt attachments; deferred bodies (init tails) show a
// placeholder until an /entries page fetch brings them at full fidelity.
function ImageRow({ images }: { images: ImageView[] }) {
  if (images.length === 0) return null
  return (
    <div className="image-row">
      {images.map((img, i) =>
        img.data !== undefined ? (
          <img
            key={i}
            alt=""
            src={`data:${img.mediaType};base64,${img.data}`}
            className="entry-image"
          />
        ) : (
          <span key={i} className="muted" data-testid="deferred-image">
            [image {img.mediaType} not loaded]
          </span>
        ),
      )}
    </div>
  )
}

// systemText renders the familiar types as chips; unknown payload fields
// round-trip upstream, so anything missing reads generically.
function systemText(type: string, d: Record<string, unknown>): string {
  switch (type) {
    case 'session':
      return `session · cwd ${str(d.cwd)}${d.model ? ` · model ${str(d.model)}` : ''}`
    case 'model_change':
      return `model changed to ${str(d.model)}${d.reason ? ` (${str(d.reason)})` : ''}`
    case 'setting_change':
      return `setting ${str(d.key)} = ${JSON.stringify(d.value)}`
    case 'session_name':
      return `renamed to ${str(d.name)}`
    case 'custom':
      return `custom: ${str(d.customType)}`
    default:
      return `[${type}]`
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '?'
}
