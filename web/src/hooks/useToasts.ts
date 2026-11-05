import { useCallback, useEffect, useRef, useState } from 'react'

// Toast display window and how many stay stacked as a new one arrives.
const toastTtlMs = 6_000
const maxKeptToasts = 4

export type ToastLevel = 'info' | 'error'

// ToastView is one live toast; rendering stays with the consumer's chrome.
export interface ToastView {
  id: number
  text: string
  level: ToastLevel
}

interface ToastsApi {
  toasts: ToastView[]
  pushToast: (text: string, level?: ToastLevel) => void
}

// useToasts owns one toast stack: pushes append under a cap and expire on
// their own, so every surface shares the same lifetime rules.
export function useToasts(): ToastsApi {
  const [toasts, setToasts] = useState<ToastView[]>([])
  const nextID = useRef(0)
  // Expiry timers tracked for teardown; React drops a post-unmount setState,
  // but clearing keeps jsdom runs and remounts free of stray callbacks.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const pushToast = useCallback((text: string, level: ToastLevel = 'info') => {
    const id = ++nextID.current
    setToasts((ts) => [...ts.slice(-maxKeptToasts), { id, text, level }])
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
