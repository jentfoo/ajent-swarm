import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dismissSwipeHint, swipeHintSeen } from './swipeHint'

// The edge-swipe hint's persistence contract: unseen until retired, retired
// forever after, and a blocked localStorage store degrades to quiet.

describe('swipeHint', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stays seen once dismissed', () => {
    dismissSwipeHint()
    expect(swipeHintSeen()).toBe(true)
  })

  it('reads blocked storage as seen', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    })
    expect(swipeHintSeen()).toBe(true)
  })

  it('survives a blocked write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => dismissSwipeHint()).not.toThrow()
  })
})
