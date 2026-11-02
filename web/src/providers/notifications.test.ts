import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNotificationBridge } from './notifications'
import type { AttentionItem } from '../workspace/attention'

// The bridge is driven with an injected notify so the tests never touch the
// real Notification API: only needs-input items announce, only while hidden,
// and each one announces exactly once until dismissed.
function item(overrides: Partial<AttentionItem> & { sessionId: string }): AttentionItem {
  return {
    kind: 'needs-input',
    reason: 'allow write?',
    since: 1,
    pid: 1,
    dialogId: 5,
    running: false,
    idle: false,
    ...overrides,
  }
}

describe('notification bridge', () => {
  let hidden: boolean
  let raised: { title: string; body: string }[]

  beforeEach(() => {
    hidden = true
    raised = []
    // jsdom ships no Notification; a granted stand-in unlocks the publish path.
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted'
        constructor(
          public title: string,
          public body: string,
        ) {}
        close() {}
      },
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function bridge() {
    return createNotificationBridge({
      hidden: () => hidden,
      notify: (title, body) => {
        raised.push({ title, body })
        return { close() {} }
      },
    })
  }

  it('announces new needs-input items once while hidden', () => {
    const b = bridge()
    const items = [item({ sessionId: 's1' }), item({ sessionId: 's2', reason: 'pick one' })]

    b.publish(items)
    expect(raised).toHaveLength(2)
    expect(raised[0]).toEqual({ title: 's1 needs input', body: 'allow write?' })

    b.publish(items) // same items stay quiet
    expect(raised).toHaveLength(2)

    // a new dialog on a known session announces again
    b.publish([item({ sessionId: 's1', dialogId: 6 })])
    expect(raised).toHaveLength(3)
  })

  it('stays silent while visible, ungranted, or without needs-input rows', () => {
    const b = bridge()
    const items = [item({ sessionId: 's1' }), item({ sessionId: 's3', kind: 'needs-review' })]

    hidden = false
    b.publish(items)
    expect(raised).toHaveLength(0)

    hidden = true
    b.publish(items) // needs-review is not desktop-notification material
    expect(raised).toHaveLength(1)

    b.dismissAll()
    b.publish([item({ sessionId: 's1' })]) // dismissed items may remind later
    expect(raised).toHaveLength(2)
  })
})
