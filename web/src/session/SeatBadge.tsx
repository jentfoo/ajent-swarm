import { useState } from 'react'

import { ApiError } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState } from '../api/types'

// SeatBadge is the takeover affordance for a seat another controller holds.
// A free seat needs no claim (writes take it lazily) and one we hold needs no
// badge, so both stay hidden and control only ever shows as contested. The
// compact variant fits the mobile header with its own label and class.
// Refusals toast the server's message, success stays quiet for the next
// snapshot to update the badge.
export function SeatBadge({
  sessionId,
  seat,
  compact = false,
  onToast,
}: {
  sessionId: string
  seat: CtlState['seat']
  compact?: boolean
  onToast: (text: string, level?: 'info' | 'error') => void
}) {
  const [busy, setBusy] = useState(false)

  if (!seat.held || seat.yours) return null

  const takeControl = async () => {
    setBusy(true)
    try {
      await sessionAPI.takeControl(sessionId)
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : 'Take control refused.', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        className="badge warn seat-claim"
        disabled={busy}
        onClick={() => void takeControl()}
      >
        {seat.holder ? `seat: ${seat.holder}` : 'seat held'}
      </button>
    )
  }

  return (
    <button
      type="button"
      className="badge warn seat-badge"
      disabled={busy}
      title={`Take control from ${seat.holder || 'another controller'}`}
      onClick={() => void takeControl()}
    >
      {`take control: ${seat.holder || 'held'}`}
    </button>
  )
}
