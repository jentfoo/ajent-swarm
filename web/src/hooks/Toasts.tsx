import type { ToastView } from './useToasts'

// Toasts is the shared toast stack both session chromes mount as their last
// child: rows in arrival order with level classes inside one polite live
// region, so politeness and stacking changes land here alone.
export function Toasts({ toasts }: { toasts: ToastView[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
