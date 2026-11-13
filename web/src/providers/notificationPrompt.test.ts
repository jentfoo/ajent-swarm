import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dismissNotificationPrompt, notificationsPromptDue } from './notificationPrompt'

// The anti-nag gates are tested against real storage and a controlled clock:
// a refusal mutes this page load, one retry follows seven days later, a second
// refusal ends the prompting for good, and corrupt storage reads as fresh.
const retryMs = 7 * 24 * 60 * 60 * 1000

describe('notification prompt state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries once after the dismissal interval', () => {
    dismissNotificationPrompt()
    expect(notificationsPromptDue('default')).toBe(false)

    vi.advanceTimersByTime(retryMs - 1)
    expect(notificationsPromptDue('default')).toBe(false)

    vi.advanceTimersByTime(1)
    expect(notificationsPromptDue('default')).toBe(true)

    // the retry's own refusal ends the prompting for good
    dismissNotificationPrompt()
    vi.advanceTimersByTime(retryMs * 10)
    expect(notificationsPromptDue('default')).toBe(false)
  })

  it('reads corrupt storage as fresh', () => {
    localStorage.setItem('swarm.notifyPrompt.v1', '{not json')
    expect(notificationsPromptDue('default')).toBe(true)

    // a shape mismatch degrades the same way, never throwing
    dismissNotificationPrompt()
    const stored = JSON.parse(localStorage.getItem('swarm.notifyPrompt.v1') ?? '') as Record<
      string,
      unknown
    >
    localStorage.setItem(
      'swarm.notifyPrompt.v1',
      JSON.stringify({ ...stored, dismissedAt: 'soon', dismissals: null }),
    )
    expect(notificationsPromptDue('default')).toBe(true)
  })
})
