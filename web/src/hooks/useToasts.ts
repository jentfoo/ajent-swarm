import { useCallback, useEffect, useRef, useState } from 'react'

// Toast display window in ms and how many toasts the stack holds at once.
const toastTtlMs = 6_000
const maxStackedToasts = 4

export type ToastLevel = 'info' | 'error'

// ToastView is one live toast row rendered by the shared <Toasts> stack.
export interface ToastView {
  id: number
  text: string
  level: ToastLevel
}

interface ToastsApi {
  toasts: ToastView[]
  pushToast: (text: string, level?: ToastLevel) => void
}

// useToasts owns one toast stack shared by every screen chrome: pushes append
// under the cap, dropping the oldest first, and each toast expires on its own.
export function useToasts(): ToastsApi {
  const [toasts, setToasts] = useState<ToastView[]>([])
  const nextID = useRef(0)
  // Expiry timers tracked for teardown, React drops a post-unmount setState,
  // but clearing keeps an expiry from firing after unmount or remount.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  // A cap-evicted toast keeps its timer, which later filters an absent id harmlessly.
  const pushToast = useCallback((text: string, level: ToastLevel = 'info') => {
    const id = ++nextID.current
    setToasts((ts) => [...ts, { id, text, level }].slice(-maxStackedToasts))
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id)
        setToasts((ts) => ts.filter((t) => t.id !== id))
      }, toastTtlMs),
    )
  }, [])

  return { toasts, pushToast }
}
