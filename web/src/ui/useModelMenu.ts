import { useCallback, useState } from 'react'

import { describeError } from '../api/errors'
import { sessions as sessionAPI } from '../api/endpoints'
import type { ModelState } from '../api/types'

export interface ModelMenuController {
  open: boolean
  busy: boolean
  models: ModelState[] // the listing for this session; empty until one lands
  active: string // the listing's active key; '' until one lands
  // toggle closes an open menu, or fetches the registry once and opens after
  // it lands, one fetch per open, never on dependency drift
  toggle: () => Promise<void>
  close: () => void
  // pick switches through model.set, the menu closes only on success
  pick: (key: string) => Promise<void>
}

// useModelMenu owns the model registry control both chat headers render: one
// models.get fetch per open, model.set picks, and the busy state around both.
// Failures surface through onToast and leave the menu closed. Consumers render
// the body through ui/ModelMenuItems, hosts key on sessionId, so a swap
// remounts and resets every piece of this state.
export function useModelMenu(
  sessionId: string,
  fallbackKey: string,
  onToast: (text: string, level?: 'info' | 'error') => void,
): ModelMenuController {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [listing, setListing] = useState<{ models: ModelState[]; active: string } | null>(null)

  const toggle = useCallback(async () => {
    if (open) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const res = await sessionAPI.models(sessionId)
      setListing({ models: res.models ?? [], active: res.active || fallbackKey })
      setOpen(true)
    } catch (err) {
      onToast(describeError(err, 'Model listing failed.'), 'error')
    } finally {
      setBusy(false)
    }
  }, [open, sessionId, fallbackKey, onToast])

  const close = useCallback(() => setOpen(false), [])

  const pick = useCallback(
    async (key: string) => {
      if (busy) return
      setBusy(true)
      try {
        await sessionAPI.setModel(sessionId, key)
        setOpen(false)
        // the switch may queue behind a running turn, status.model announces it
      } catch (err) {
        onToast(describeError(err, 'Model change refused.'), 'error')
      } finally {
        setBusy(false)
      }
    },
    [busy, sessionId, onToast],
  )

  return {
    open,
    busy,
    models: listing?.models ?? [],
    active: listing?.active ?? '',
    toggle,
    close,
    pick,
  }
}
