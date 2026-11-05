import { describe, expect, it } from 'vitest'

import { phaseText } from './phases'

// One sentence per transient phase; live and ended have their own chrome.

describe('phaseText', () => {
  it('describes every transient phase', () => {
    expect(phaseText('connecting')).toBe('Connecting to the session stream…')
    expect(phaseText('resyncing')).toBe('Connection was interrupted; resnapshotting…')
    expect(phaseText('lost')).toMatch(/not reachable/)
  })

  it('answers empty for phases with their own chrome', () => {
    expect(phaseText('live')).toBe('')
    expect(phaseText('ended')).toBe('')
  })
})
