import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNotificationBridge } from './notifications'
import type { NotificationRequest } from './notifications'
import type { AttentionItem } from '../workspace/attention'

// The bridge is driven with an injected notify so the tests never touch the
// real Notification API: only needs-input items announce, only while hidden,
// each one announces exactly once until dismissed, and a settled dialog
// closes its own notification.
function item(overrides: Partial<AttentionItem> & { sessionId: string }): AttentionItem {
  return {
    kind: 'needs-input',
    reason: 'allow write?',
    since: 1,
    pid: 1,
    dialogId: 5,
    running: false,
    ...overrides,
  }
}

interface Raised {
  req: NotificationRequest
  closed: boolean
}

// jsdom ships no Notification; a granted stand-in that records every
// construction unlocks the publish path and covers the default wiring.
class StubNotification {
  static permission = 'granted'
  closed = false
  onclick: ((ev: Event) => void) | null = null
  constructor(
    public title: string,
    public options: { body?: string; tag?: string },
  ) {
    instances.push(this)
  }
  close() {
    this.closed = true
  }
}

let hidden: boolean
let raised: Raised[]
let opened: string[]
let names: Record<string, string>
let instances: StubNotification[]

describe('notification bridge', () => {
  beforeEach(() => {
    hidden = true
    raised = []
    opened = []
    names = {}
    instances = []
    vi.stubGlobal('Notification', StubNotification)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function bridge() {
    return createNotificationBridge({
      hidden: () => hidden,
      notify: (req) => {
        const entry: Raised = { req, closed: false }
        raised.push(entry)
        return {
          close() {
            entry.closed = true
          },
        }
      },
    })
  }

  // the host an app supplies: display names plus the click-through
  function host() {
    return {
      nameFor: (id: string) => names[id] ?? id,
      openSession: (id: string) => {
        opened.push(id)
      },
    }
  }

  it('announces new needs-input items once while hidden', () => {
    const b = bridge()
    names = { s1: 'Frontend', s2: 'Backend' }
    const items = [item({ sessionId: 's1' }), item({ sessionId: 's2', reason: 'pick one' })]

    b.publish(items, host())
    expect(raised).toHaveLength(2)
    expect(raised[0].req).toMatchObject({
      title: 'Frontend needs input',
      body: 'allow write?',
      tag: 's1',
    })
    // distinct tags keep different sessions from merging in the tray
    expect(raised[1].req).toMatchObject({ title: 'Backend needs input', tag: 's2' })

    b.publish(items, host()) // same items stay quiet
    expect(raised).toHaveLength(2)

    // a new dialog on a known session announces again, one tray slot per tag
    b.publish([item({ sessionId: 's1', dialogId: 6 })], host())
    expect(raised).toHaveLength(3)
    expect(raised[2].req.tag).toBe('s1')
  })

  it('activating a notification opens that session', () => {
    const b = bridge()

    b.publish([item({ sessionId: 's1' })], host())
    raised[0].req.onclick()

    expect(opened).toEqual(['s1'])
  })

  it('closes a settled dialog and re-announces when it rises again', () => {
    const b = bridge()
    b.publish([item({ sessionId: 's1' }), item({ sessionId: 's2' })], host())
    expect(raised.map((r) => r.closed)).toEqual([false, false])

    // s1 settled (its turn moved on to review): only its notification closes
    b.publish(
      [
        item({ sessionId: 's2' }),
        item({ sessionId: 's1', kind: 'needs-review', dialogId: undefined, turnEnd: 9 }),
      ],
      host(),
    )
    expect(raised.map((r) => r.closed)).toEqual([true, false])

    // rising again later announces fresh, never before
    b.publish([item({ sessionId: 's1' })], host())
    expect(raised).toHaveLength(3)
    expect(raised[2].closed).toBe(false)
  })

  it('stays silent while visible, ungranted, or without needs-input rows', () => {
    const b = bridge()
    const items = [item({ sessionId: 's1' }), item({ sessionId: 's3', kind: 'needs-review' })]

    hidden = false
    b.publish(items, host())
    expect(raised).toHaveLength(0)

    hidden = true
    b.publish(items, host()) // needs-review is not desktop-notification material
    expect(raised).toHaveLength(1)

    b.dismissAll()
    expect(raised[0].closed).toBe(true)
    b.publish([item({ sessionId: 's1' })], host()) // dismissed items may remind later
    expect(raised).toHaveLength(2)
  })

  it('wires tag and click-through through the platform notification', () => {
    const b = createNotificationBridge({ hidden: () => true })

    b.publish([item({ sessionId: 's1' })], host())

    expect(instances).toHaveLength(1)
    expect(instances[0].title).toBe('s1 needs input')
    expect(instances[0].options).toEqual({ body: 'allow write?', tag: 's1' })

    instances[0].onclick?.(new Event('click'))
    expect(opened).toEqual(['s1'])
    expect(instances[0].closed).toBe(true) // click-through consumes the toast
  })
})
