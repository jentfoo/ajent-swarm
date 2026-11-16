import type { LiveTurn } from '../state/eventApplier'

// BarrierHold is the live stream's split while a dialog holds the turn: the
// cards that paint, how many calls wait behind the answer, and the id of the
// call the open dialog gates (undefined when nothing is gated).
export interface BarrierHold {
  shown: LiveTurn['tools']
  held: number
  gatedId?: string
}

// barrierHold splits the live tool cards while a dialog holds the turn. A batch
// that can prompt runs one call at a time, so the first card without a result is
// the call the open dialog gates and every later call only queues behind the
// answer: holding those back keeps the dialog reading against the one action it
// decides. Without an open dialog nothing holds, and a settled batch releases
// too. Staged user shell runs execute outside the turn's dispatch, so they
// always paint.
export function barrierHold(tools: LiveTurn['tools'], dialogOpen: boolean): BarrierHold {
  if (!dialogOpen) return { shown: tools, held: 0 }
  let cut = -1
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i]
    if (t.shell === true) continue
    if (t.result === undefined && t.closed !== true) {
      cut = i
      break
    }
  }
  if (cut < 0) return { shown: tools, held: 0 }
  const shown = tools.filter((t, i) => i <= cut || t.shell === true)
  return { shown, held: tools.length - shown.length, gatedId: tools[cut].id }
}
