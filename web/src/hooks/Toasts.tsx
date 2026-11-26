import { CloseIcon } from '../ui/icons'
import type { ToastView } from './useToasts'

// Toasts is the shared toast stack both session chromes mount as their last
// child: rows in arrival order with level classes, each its own live region so
// info reads politely and an error asserts. The wrapper is layout only, so an
// arriving row never re-announces the stack, and it stays mounted while empty
// to keep the container's identity stable.
export function Toasts({
  toasts,
  onDismiss,
  onPause,
  onResume,
}: {
  toasts: ToastView[]
  onDismiss: (id: number) => void
  onPause: (id: number) => void
  onResume: (id: number) => void
}) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.level}`}
          role={t.level === 'error' ? 'alert' : 'status'}
          aria-atomic="true"
          // a finger tapping through must not park the row, only a resting mouse
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') onPause(t.id)
          }}
          onPointerLeave={(e) => {
            // the focused close button keeps its hold after the pointer leaves
            if (e.pointerType === 'mouse' && !e.currentTarget.contains(document.activeElement)) {
              onResume(t.id)
            }
          }}
        >
          <span className="toast-text">{t.text}</span>
          <button
            type="button"
            className="icon-btn toast-close"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
            onFocus={() => onPause(t.id)}
            onBlur={() => onResume(t.id)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
