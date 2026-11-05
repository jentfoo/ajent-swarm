import { useState } from 'react'

import { sessions as sessionAPI } from '../api/endpoints'
import type { CtlState } from '../api/types'

// SeatBadge is the takeover affordance for a seat another controller holds.
// A free seat needs no claim (writes take it lazily) and one we hold needs no
// badge, so both stay hidden and control only ever shows as contested. The
// compact variant fits the mobile header with its own label and class.
export function SeatBadge({
  sessionId,
  seat,
  compact = false,
}: {
  sessionId: string
  seat: CtlState['seat']
  compact?: boolean
}) {
  const [busy, setBusy] = useState(false)

  if (!seat.held || seat.yours) return null

  const takeControl = async () => {
    setBusy(true)
    try {
      await sessionAPI.takeControl(sessionId)
    } catch {
      // Refusals keep their holder name; the next snapshot updates the badge.
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
