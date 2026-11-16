import { useCopyText, type CopyState } from './useCopyText'

// state cells: one clipboard-style icon plus an sr-only label per state, so
// the accessible name is whatever shows and a swap never resizes the button
// (the transcript virtualizer measures rows)
const cells: Array<[CopyState, string]> = [
  ['idle', 'Copy'],
  ['copied', 'Copied'],
  ['failed', 'Copy failed'],
]

function stateIcon(state: CopyState) {
  switch (state) {
    case 'copied':
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      )
    case 'failed':
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M15 9l-6 6M9 9l6 6" />
        </svg>
      )
    default:
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" />
        </svg>
      )
  }
}

// CopyButton writes raw text on click and renders the outcome as its icon:
// clipboard idle, check copied, circled X failed. A native title carries the
// label for pointer users.
export function CopyButton({ text, className }: { text: string; className: string }) {
  const { copy, state } = useCopyText()
  return (
    <button
      type="button"
      className={`copy-btn ${className}`}
      title={cells.find(([s]) => s === state)?.[1]}
      onClick={() => copy(text)}
    >
      <span className="copy-labels">
        {cells.map(([s, label]) => (
          <span key={s} data-on={state === s} aria-hidden={state !== s}>
            {stateIcon(s)}
            <span className="sr-only">{label}</span>
          </span>
        ))}
      </span>
    </button>
  )
}
