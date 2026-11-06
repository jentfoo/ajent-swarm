import { useCopyText, type CopyState } from './useCopyText'

const labels: [CopyState, string][] = [
  ['idle', 'Copy'],
  ['copied', 'Copied'],
  ['failed', 'Copy failed'],
]

// CopyButton writes raw text on click and renders the transient outcome as its
// label. Every label occupies one grid cell (see .copy-labels), so the button
// keeps a fixed box across states and never reflows a row the transcript
// virtualizer is measuring.
export function CopyButton({ text, className }: { text: string; className: string }) {
  const { copy, state } = useCopyText()
  return (
    <button type="button" className={`copy-btn ${className}`} onClick={() => copy(text)}>
      <span className="copy-labels">
        {labels.map(([s, label]) => (
          <span key={s} data-on={state === s} aria-hidden={state !== s}>
            {label}
          </span>
        ))}
      </span>
    </button>
  )
}
