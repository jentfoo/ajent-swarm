import { describe, expect, it } from 'vitest'

import { applierReducer, initialSessionState } from './eventApplier'
import type { ApplierAction, AppliedSessionState } from './eventApplier'
import { entry, ev, initFrame, messageEntry, testState } from './testFixtures'
import type { CtlState, WireEvent } from '../api/types'

// Events pass straight through; actions carry their own type tag.
type ApplyItem = ApplierAction | WireEvent

function apply(state: AppliedSessionState, ...items: ApplyItem[]): AppliedSessionState {
  return items.reduce<AppliedSessionState>((s, item) => {
    const action: ApplierAction =
      'type' in item ? (item as ApplierAction) : { type: 'event', event: item }
    return applierReducer(s, action)
  }, state)
}

const snap = (overrides: Partial<CtlState> = {}): CtlState => testState(overrides)

describe('applierReducer init', () => {
  it('seeds chain and resets watermark', () => {
    const root = messageEntry('01A', undefined, 'user', 'hello')
    const reply = messageEntry('01B', '01A', 'assistant', 'hi there')
    const state = snap({ head: '01B' })

    let s = apply(initialSessionState(), { type: 'init', frame: initFrame(state, [root, reply]) })
    expect(s.entries.size).toBe(2)
    expect(s.chain.ids).toEqual(['01A', '01B'])
    expect(s.chain.rooted).toBe(true)
    expect(s.snapshot.head).toBe('01B')
    expect(s.seq).toBe(0)

    // An event below a later watermark still applies after init: the
    // subscription forwards only post-attach events.
    s = apply(s, ev('idle', 412, { idle: false }))
    expect(s.seq).toBe(412)
  })

  it('marks truncated history unrooted', () => {
    const tail = messageEntry('01TAIL', '01PARENT', 'assistant', 'newer')
    const s = apply(initialSessionState(), {
      type: 'init',
      frame: initFrame(snap({ head: '01TAIL' }), [tail], '01TAIL'),
    })
    expect(s.chain.ids).toEqual(['01TAIL'])
    expect(s.chain.rooted).toBe(false)
  })
})

describe('applierReducer watermark gate', () => {
  it('drops events at or below the last applied seq', () => {
    let s = apply(initialSessionState(), ev('idle', 10, { idle: false }))
    const before = s.snapshot.idle
    s = apply(s, ev('idle', 10, { idle: true }), ev('idle', 9, { idle: true }))
    expect(s.seq).toBe(10)
    expect(s.snapshot.idle).toBe(before)
    s = apply(s, ev('idle', 11, { idle: true }))
    expect(s.snapshot.idle).toBe(true)
  })
})

describe('applierReducer committed family', () => {
  it('dedupes overlap between init and live appends by entry id', () => {
    const root = messageEntry('01A', undefined, 'user', 'hello')
    let s = apply(initialSessionState(), {
      type: 'init',
      frame: initFrame(snap({ head: '01A' }), [root]),
    })

    // The same entry arriving as a live event renders once and moves the head.
    s = apply(s, ev('entry.append', 5, { entry: root }))
    expect(s.entries.size).toBe(1)
    expect(s.chain.ids).toEqual(['01A'])
    expect(s.snapshot.head).toBe('01A')

    const reply = messageEntry('01B', '01A', 'assistant', 'hi')
    s = apply(s, ev('entry.append', 6, { entry: reply }))
    expect(s.chain.ids).toEqual(['01A', '01B'])
  })

  it('re-roots on branch.changed and heals through paged backfill', () => {
    const root = messageEntry('01ROOT', undefined, 'user', 'root')
    const keep = messageEntry('01KEEP', '01ROOT', 'assistant', 'kept')
    // Init carries only the tail of the current branch.
    let s = apply(initialSessionState(), {
      type: 'init',
      frame: initFrame(snap({ head: '01KEEP' }), [keep], '01KEEP'),
    })

    // A rewind to an entry older than anything held leaves the chain incomplete.
    s = apply(s, ev('branch.changed', 7, { from: '01KEEP', head: '01ROOT', cause: 'rewind' }))
    expect(s.snapshot.head).toBe('01ROOT')
    expect(s.chain.rooted).toBe(false)
    expect(s.healTick).toBe(1)

    // The page fetch bridges the gap; overlap with what we hold dedupes.
    const older = messageEntry('01OLDER', '01ROOT', 'user', 'prompt')
    s = apply(s, { type: 'backfill', entries: [older, root] })
    expect(s.chain.rooted).toBe(true)
    expect(s.chain.ids).toEqual(['01ROOT'])
  })

  it('pages across several fetches before the chain roots', () => {
    // Init holds one entry whose parent was trimmed away.
    let s = apply(initialSessionState(), {
      type: 'init',
      frame: initFrame(snap({ head: '01D' }), [messageEntry('01D', '01C', 'user', 'd')], '01D'),
    })
    expect(s.chain.rooted).toBe(false)

    // A rewind to an entry we do not hold at all leaves nothing to walk.
    s = apply(s, ev('branch.changed', 1, { from: '01D', head: '01C', cause: 'rewind' }))
    expect(s.chain.ids).toEqual([])
    expect(s.healTick).toBe(1)

    // First page bridges to the next gap; only a later page reaches a root.
    s = apply(s, { type: 'backfill', entries: [messageEntry('01C', '01B', 'assistant', 'c')] })
    expect(s.chain.ids).toEqual(['01C'])
    expect(s.chain.rooted).toBe(false)

    const root = messageEntry('01A', undefined, 'user', 'a')
    s = apply(s, {
      type: 'backfill',
      entries: [root, messageEntry('01B', '01A', 'assistant', 'b')],
    })
    expect(s.chain.ids).toEqual(['01A', '01B', '01C'])
    expect(s.chain.rooted).toBe(true)
    expect(s.healTick).toBe(1) // only branch changes ask for healing
  })

  it('cycle guards a corrupt parent chain', () => {
    const a = entry('01CYC_A', '01CYC_B', 'notice', { message: 'a' })
    const b = entry('01CYC_B', '01CYC_A', 'notice', { message: 'b' })
    const s = apply(initialSessionState(), {
      type: 'init',
      frame: initFrame(snap({ head: '01CYC_A' }), [a, b]),
    })
    expect(s.chain.ids.length).toBeLessThanOrEqual(2)
  })
})

describe('applierReducer dialogs', () => {
  const dialog = (id: number) => ({
    id,
    kind: 'confirm',
    prompt: 'Allow write access?',
    options: ['allow', 'deny'],
  })

  it('survives a resnapshot across an open dialog', () => {
    let s = apply(initialSessionState(), ev('interaction.pending', 1, dialog(7)))
    expect(s.snapshot.interactions).toHaveLength(1)

    // A snapshot taken while the dialog still holds the run keeps it.
    s = apply(s, { type: 'snapshot', state: snap({ interactions: [dialog(7)], queuedRows: [] }) })
    expect(s.snapshot.interactions).toEqual([dialog(7)])

    // Settled closes it; a snapshot no longer listing it clears it too.
    s = apply(s, ev('interaction.settled', 2, { id: 7 }))
    expect(s.snapshot.interactions).toHaveLength(0)
    const cleared = apply(s, ev('interaction.pending', 3, dialog(8)), {
      type: 'snapshot',
      state: snap(),
    })
    expect(cleared.snapshot.interactions).toEqual([])
  })

  it('re-announcements update in place by dialog id', () => {
    let s = apply(initialSessionState(), ev('interaction.pending', 1, dialog(7)))
    const reshaped = { ...dialog(7), prompt: 'Allow write access to /tmp?' }
    s = apply(s, ev('interaction.pending', 2, reshaped))
    expect(s.snapshot.interactions).toEqual([reshaped])
  })
})

describe('applierReducer queue rows', () => {
  it('replaces queued rows wholesale and respects secret redaction', () => {
    // Transcribed from control-api.md: secret prompts arrive with an id and
    // an empty text, in queued, in queue.dropped and in snapshots.
    let s = apply(
      initialSessionState(),
      ev('queued', 1, {
        rows: [
          { id: 'c1', text: 'explain this diff' },
          { id: 's2', text: '' },
        ],
      }),
    )
    expect(s.snapshot.queuedRows).toEqual([
      { id: 'c1', text: 'explain this diff' },
      { id: 's2', text: '' },
    ])
    expect(s.snapshot.queued).toBe(2)

    s = apply(s, ev('queue.dropped', 2, { rows: [{ id: 's2', text: '' }], cause: 'recalled' }))
    expect(s.snapshot.queuedRows).toEqual([{ id: 'c1', text: 'explain this diff' }])
  })

  it('resolves optimistic submits by queueIds on the committed entry', () => {
    let s = apply(initialSessionState(), {
      type: 'pendingSubmitted',
      pendingId: 'p1',
      text: 'fix it',
    })
    expect(s.pendings).toEqual([{ id: 'p1', text: 'fix it', state: 'pending' }])

    // The queued event names the row by our correlation id.
    s = apply(s, ev('queued', 1, { rows: [{ id: 'p1', text: 'fix it' }] }))
    expect(s.pendings[0].state).toBe('queued')

    // The committed entry lands with queueIds naming what it delivered.
    const landed = entry(
      '01M',
      undefined,
      'message',
      JSON.parse('{"message":{"role":"user","content":[]},"queueIds":["p1"]}'),
    )
    s = apply(s, ev('entry.append', 2, { entry: landed }))
    expect(s.pendings[0].state).toBe('committed')
  })

  it('resolves optimistic submits dropped by an interrupt', () => {
    let s = apply(initialSessionState(), {
      type: 'pendingSubmitted',
      pendingId: 'p1',
      text: 'fix it',
    })
    s = apply(s, ev('queued', 1, { rows: [{ id: 'p1', text: 'fix it' }] }))
    s = apply(
      s,
      ev('queue.dropped', 2, { rows: [{ id: 'p1', text: 'fix it' }], cause: 'interrupt' }),
    )
    expect(s.pendings[0].state).toBe('dropped')
  })

  it('reconciles optimistic rows against a fresh init only when named', () => {
    const queuedInit = snap({ queuedRows: [{ id: 'p1', text: 'kept' }] })
    let s = apply(
      initialSessionState(),
      { type: 'pendingSubmitted', pendingId: 'p1', text: 'kept' },
      { type: 'pendingSubmitted', pendingId: 'p2', text: 'stale' },
    )
    s = apply(s, { type: 'init', frame: initFrame(queuedInit, []) })
    expect(s.pendings).toEqual([{ id: 'p1', text: 'kept', state: 'queued' }])
  })
})

describe('applierReducer keyed families', () => {
  it('replaces activity rows and removes on empty text', () => {
    let s = apply(
      initialSessionState(),
      ev('activity', 1, { key: 'grep', text: 'searching…', rank: 2 }),
    )
    expect(s.snapshot.activity).toEqual([{ key: 'grep', text: 'searching…', rank: 2 }])
    s = apply(s, ev('activity', 2, { key: 'grep', text: 'reading files', rank: 2 }))
    expect(s.snapshot.activity).toHaveLength(1)
    s = apply(s, ev('activity', 3, { key: 'grep', text: '' }))
    expect(s.snapshot.activity).toEqual([])
  })

  it('replaces status segments and reconciles the spinner from snapshots too', () => {
    let s = apply(
      initialSessionState(),
      ev('status', 1, { segment: { key: 'mode', text: 'auto', order: 3 } }),
      ev('status', 2, { spinning: true }),
      ev('status', 3, { model: testState().model }),
    )
    expect(s.snapshot.status?.segments).toEqual([{ key: 'mode', text: 'auto', order: 3 }])
    expect(s.snapshot.spinning).toBe(true)
    s = apply(s, ev('status', 4, { segment: { key: 'mode', text: '', order: 3 } }))
    expect(s.snapshot.status?.segments).toEqual([])
    // A drop can lose the spinning:false event; a resnapshot clears it.
    s = apply(s, { type: 'snapshot', state: snap({ spinning: false }) })
    expect(s.snapshot.spinning).toBe(false)
  })

  it('keyed notices replace in place while unkeyed stack', () => {
    const s = apply(
      initialSessionState(),
      ev('notice', 1, { text: 'staged', level: 'info', key: 'staged' }),
      ev('notice', 2, { text: 'still staged', level: 'info', key: 'staged' }),
      ev('notice', 3, { text: 'unrelated', level: 'warn' }),
    )
    expect(s.notices).toEqual([
      { key: 'staged', text: 'still staged', level: 'info' },
      { key: '', text: 'unrelated', level: 'warn' },
    ])
  })
})

describe('applierReducer live turn buffers', () => {
  it('tolerates tool.progress before tool.start and result without start', () => {
    let s = apply(
      initialSessionState(),
      ev('tool.progress', 1, { id: 'call9', name: 'read_file', path: '/tmp/x' }),
    )
    expect(s.live?.tools).toEqual([
      { id: 'call9', name: 'read_file', outputs: [], progress: { path: '/tmp/x' } },
    ])

    s = apply(
      s,
      ev('tool.start', 2, { id: 'call9', name: 'read_file', input: '{"path":"/tmp/x"}' }),
      ev('tool.output', 3, { id: 'call9', delta: 'contents' }),
      ev('tool.result', 4, { id: 'call9', name: 'read_file', output: 'contents done' }),
    )
    const tool = s.live?.tools[0]
    expect(tool?.outputs).toEqual(['contents'])
    // A surface that already painted the deltas ignores result.output.
    expect(tool?.result?.output).toBe('contents done')

    // A result for a never-started call still renders its header.
    const s2 = apply(
      initialSessionState(),
      ev('tool.result', 1, { id: 'callX', name: 'bash', output: '', error: true }),
    )
    expect(s2.live?.tools[0]).toMatchObject({ id: 'callX', name: 'bash' })
    expect(s2.live?.tools[0].result).toEqual({ output: '', error: true })
  })

  it('buffers deltas across a lost turn.start and closes on turn.end', () => {
    let s = apply(
      initialSessionState(),
      ev('text.delta', 1, { delta: 'Hel' }),
      ev('text.delta', 2, { delta: 'lo' }),
    )
    expect(s.live?.text).toBe('Hello')
    const before = Date.now()
    s = apply(s, ev('turn.end', 3, { stop: 'end_turn', steps: 1 }))
    expect(s.live).toBeNull()
    expect(s.snapshot.running).toBe(false)
    expect(s.lastTurnEndAt).toBeGreaterThanOrEqual(before - 1000)
  })

  it('keeps the spinner off the live path', () => {
    let s = apply(initialSessionState(), ev('turn.start', 1, { model: 'm' }))
    expect(s.snapshot.running).toBe(true)
    // spinning is not a turn event's job; snapshots reconcile it.
    s = apply(s, ev('status', 2, { spinning: true }), ev('turn.end', 3, {}))
    expect(s.snapshot.spinning).toBe(true)
  })
})

describe('applierReducer resnapshot poll-only fields', () => {
  it('merges identity, cwd and usage without clobbering event state', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('permission', 2, { mode: 'auto' }),
      ev('idle', 3, { idle: false }),
    )
    const fresh = snap({
      cwd: '/somewhere/else',
      session: { id: s.snapshot.session.id, name: 'renamed' },
      permission: 'allow-read', // stale read; event state wins
      usage: { turns: 5, total: zeroUsage(), child: zeroUsage(), estimatedTurns: 0 },
    })
    s = apply(s, { type: 'snapshot', state: fresh })
    expect(s.snapshot.cwd).toBe('/somewhere/else')
    expect(s.snapshot.session.name).toBe('renamed')
    expect(s.snapshot.usage.turns).toBe(5)
    expect(s.snapshot.permission).toBe('auto') // untouched
    expect(s.snapshot.idle).toBe(false) // untouched
    expect(s.snapshot.running).toBe(true) // untouched
  })
})

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

describe('applierReducer lifecycle', () => {
  it('records session.exit and seat loss', () => {
    let s = apply(initialSessionState(), ev('session.exit', 1, { reason: 'done' }))
    expect(s.exitReason).toBe('done')
    s = apply(initialSessionState(), ev('seat.lost', 1, { from: 'swarm', to: 'human-2' }))
    expect(s.snapshot.seat).toEqual({ held: true, holder: 'human-2', yours: false })
  })

  it('ignores unknown events without breaking the stream', () => {
    const s = apply(initialSessionState(), ev('future.event', 1, { anything: true }))
    expect(s.seq).toBe(1)
  })
})
