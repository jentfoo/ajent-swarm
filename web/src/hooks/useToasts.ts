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

// one running expiry: its timer and the wall-clock instant it aims at
interface ArmedToast {
  timer: ReturnType<typeof setTimeout>
  expiresAt: number
}

interface ToastsApi {
  toasts: ToastView[]
  pushToast: (text: string, level?: ToastLevel) => void
  // dismissToast removes one toast and cancels its expiry, so a closed row never returns.
  dismissToast: (id: number) => void
  // pauseToast holds one toast's expiry, keeping the time it still owes.
  pauseToast: (id: number) => void
  // resumeToast restarts a paused toast's expiry from the time it still owes.
  resumeToast: (id: number) => void
}

// useToasts owns one toast stack shared by every screen chrome: pushes append
// under the cap, dropping the oldest first, and each toast expires on its own
// unless a hover or a focused close button holds it.
export function useToasts(): ToastsApi {
  const [toasts, setToasts] = useState<ToastView[]>([])
  const nextID = useRef(0)
  // Expiry per running toast: the timer and the instant it aims at, so a pause
  // can compute what the row still owes. Tracked so teardown clears every
  // timer, keeping an expiry from firing after a remount; React drops a
  // post-unmount setState on its own.
  const armed = useRef(new Map<number, ArmedToast>())
  // Time a paused toast still owes, re-armed by a resume.
  const held = useRef(new Map<number, number>())

  const dismissToast = useCallback((id: number) => {
    clearTimeout(armed.current.get(id)?.timer)
    armed.current.delete(id)
    held.current.delete(id)
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])

  const arm = useCallback(
    (id: number, left: number) => {
      armed.current.set(id, {
        timer: setTimeout(() => dismissToast(id), left),
        expiresAt: Date.now() + left,
      })
    },
    [dismissToast],
  )

  useEffect(() => {
    const running = armed.current
    const paused = held.current
    return () => {
      for (const { timer } of running.values()) clearTimeout(timer)
      running.clear()
      paused.clear()
    }
  }, [])

  // A cap-evicted toast keeps its timer, which later filters an absent id harmlessly.
  const pushToast = useCallback(
    (text: string, level: ToastLevel = 'info') => {
      const id = ++nextID.current
      setToasts((ts) => [...ts, { id, text, level }].slice(-maxStackedToasts))
      arm(id, toastTtlMs)
    },
    [arm],
  )

  const pauseToast = useCallback((id: number) => {
    const entry = armed.current.get(id)
    // an already paused, expired or evicted row has nothing to hold
    if (entry === undefined) return
    clearTimeout(entry.timer)
    armed.current.delete(id)
    held.current.set(id, Math.max(entry.expiresAt - Date.now(), 0))
  }, [])

  const resumeToast = useCallback(
    (id: number) => {
      const left = held.current.get(id)
      if (left === undefined) return
      held.current.delete(id)
      arm(id, left)
    },
    [arm],
  )

  return { toasts, pushToast, dismissToast, pauseToast, resumeToast }
}
