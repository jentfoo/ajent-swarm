import { describe, expect, it } from 'vitest'

import { endedBanner } from './phases'

// The one banner derivation both session surfaces consume, pinning it here
// keeps desktop and mobile copy from drifting apart again (phases.tsx).

describe('endedBanner', () => {
  it.each<[string, 'live' | 'ended', string | undefined, boolean, string]>([
    ['hides a live session without exit', 'live', undefined, false, 'Session ended.'],
    ['shows on the settled phase', 'ended', undefined, true, 'Session ended.'],
    ['shows before the phase settles', 'live', 'sigterm', true, 'Session ended: sigterm.'],
    ['empty reason keeps plain copy', 'ended', '', true, 'Session ended.'],
  ])('%s', (_name, phase, reason, show, text) => {
    expect(endedBanner(phase, reason)).toEqual({ show, text })
  })
})
