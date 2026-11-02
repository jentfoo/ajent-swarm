import { useState } from 'react'
import type { ImageView, ToolResultView } from '../state/derive'

// ToolCardView is what a card renders: a committed call's info or the live
// shape with its streamed outputs. Live output appends while running; once
// deltas painted the body, result.output adds nothing.
export interface ToolCardView {
  id: string
  name?: string
  input?: unknown
  outputs?: string[]
  progress?: { path?: string; bytes?: number; lines?: number }
  result?: ToolResultView
}

export function ToolCallCard({ call, running }: { call: ToolCardView; running?: boolean }) {
  const [open, setOpen] = useState(false)
  const streamed = (call.outputs ?? []).join('')
  // Deltas already painted the body when present; the committed result only
  // fills a card whose stream nobody rendered.
  const body = streamed !== '' ? streamed : (call.result?.text ?? '')
  const images = call.result?.images ?? []
  const failed = call.result?.isError === true
  const done = running ?? call.result !== undefined
  const label = call.name || call.progress?.path || call.id

  return (
    <div className={`tool-card ${failed ? 'error' : ''}`} data-tool-id={call.id}>
      <button type="button" className="tool-header" onClick={() => setOpen((v) => !v)}>
        <span className="mono">{label}</span>
        {!done && <span className="badge accent">running</span>}
        {done &&
          (failed ? (
            <span className="badge danger">failed</span>
          ) : (
            <span className="badge ok">done</span>
          ))}
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
