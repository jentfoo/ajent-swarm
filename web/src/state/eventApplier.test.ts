import { describe, expect, it } from 'vitest'

import { applierReducer, initialSessionState, sessionBusy } from './eventApplier'
import type { ApplierAction, AppliedSessionState } from './eventApplier'
import { entry, ev, initFrame, messageEntry, testState } from './testFixtures'
import type { Entry } from '../api/types'
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

  it('records the real outcome when a dialog settles elsewhere', () => {
    let s = apply(initialSessionState(), ev('interaction.pending', 1, dialog(7)))
    s = apply(s, ev('interaction.settled', 2, { id: 7, kind: 'confirm', answered: true, index: 1 }))
    expect(s.snapshot.interactions).toEqual([])
    expect(s.resolvedElsewhere).toEqual([{ id: 7, answered: true, cancelled: false, index: 1 }])

    // A cancel settles too, never as an error.
    s = apply(initialSessionState(), ev('interaction.pending', 1, dialog(8)), {
      type: 'event',
      event: ev('interaction.settled', 2, { id: 8, kind: 'confirm', cancelled: true }),
    })
    expect(s.resolvedElsewhere).toEqual([{ id: 8, answered: false, cancelled: true }])
  })

  it('suppresses the elsewhere outcome for dialogs this client answered', () => {
    let s = apply(initialSessionState(), ev('interaction.pending', 1, dialog(7)))
    s = apply(s, { type: 'dialogAnswered', dialogId: 7 })
    s = apply(s, ev('interaction.settled', 2, { id: 7, kind: 'confirm', answered: true, index: 0 }))
    expect(s.resolvedElsewhere).toEqual([])

    // The local marker clears with the settle so a reused id stays honest.
    s = apply(initialSessionState(), ev('interaction.pending', 3, dialog(7)))
    s = apply(s, ev('interaction.settled', 4, { id: 7, kind: 'confirm', answered: true, index: 0 }))
    expect(s.resolvedElsewhere).toHaveLength(1)
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

  it('badges dropped rows with their cause', () => {
    const s = apply(
      initialSessionState(),
      ev('queued', 1, {
        rows: [
          { id: 'a', text: 'one' },
          { id: 'b', text: 'two' },
        ],
      }),
      ev('queue.dropped', 2, { rows: [{ id: 'a', text: 'one' }], cause: 'interrupt' }),
    )
    expect(s.snapshot.queuedRows).toEqual([{ id: 'b', text: 'two' }])
    expect(s.droppedRows).toEqual([{ id: 'a', text: 'one', cause: 'interrupt' }])
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

  it('marks refused submits failed without touching queued rows', () => {
    let s = apply(
      initialSessionState(),
      { type: 'pendingSubmitted', pendingId: 'p1', text: 'fix' },
      ev('queued', 1, { rows: [{ id: 'other', text: 'already queued' }] }),
    )
    s = apply(s, { type: 'pendingFailed', pendingId: 'p1' })
    expect(s.pendings).toEqual([{ id: 'p1', text: 'fix', state: 'failed' }])

    // A resolved row never reverts on a late failure.
    s = apply(s, { type: 'pendingFailed', pendingId: 'other' })
    expect(s.pendings).toHaveLength(1)
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

  it('carries segment counts whole', () => {
    let s = apply(
      initialSessionState(),
      ev('status', 1, {
        segment: {
          key: 'subagents',
          text: 'subagents: 2 running, 1 done',
          order: 40,
          counts: { running: 2, queued: 0, done: 1 },
        },
      }),
    )
    expect(s.snapshot.status?.segments).toEqual([
      {
        key: 'subagents',
        text: 'subagents: 2 running, 1 done',
        order: 40,
        counts: { running: 2, queued: 0, done: 1 },
      },
    ])
    // a tally-less replacement drops the stale counts, never mixes them
    s = apply(
      s,
      ev('status', 2, { segment: { key: 'subagents', text: 'subagents: 3 done', order: 40 } }),
    )
    expect(s.snapshot.status?.segments).toEqual([
      { key: 'subagents', text: 'subagents: 3 done', order: 40, counts: undefined },
    ])
    // empty text still removes the row, tallies included
    s = apply(s, ev('status', 3, { segment: { key: 'subagents', text: '', order: 40 } }))
    expect(s.snapshot.status?.segments).toEqual([])
  })

  it('keyed notices replace in place while unkeyed stack', () => {
    const s = apply(
      initialSessionState(),
      ev('notice', 1, { text: 'staged', level: 'info', key: 'staged' }),
      ev('notice', 2, { text: 'still staged', level: 'info', key: 'staged' }),
      ev('notice', 3, { text: 'unrelated', level: 'warn' }),
    )
    // arrival stamps ride every row so rendering can expire stale lines
    expect(s.notices).toMatchObject([
      { key: 'staged', text: 'still staged', level: 'info' },
      { key: '', text: 'unrelated', level: 'warn' },
    ])
    for (const n of s.notices) expect(n.at).toBeGreaterThan(0)
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
    // painted content stays instead of being discarded with the buffer
    expect(s.live?.text).toBe('Hello')
    expect(s.live?.textOpen).toBe(false)
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

  it('seeds every live buffer expanded, turn.start or not', () => {
    const started = apply(initialSessionState(), ev('turn.start', 1, { model: 'm' }))
    expect(started.live?.thinkingOpen).toBe(true)

    // a mid-turn join rebuilds the buffer through the fallback path
    const joined = apply(initialSessionState(), ev('thinking.delta', 1, { delta: 'hmm' }))
    expect(joined.live?.thinkingOpen).toBe(true)
  })
})

describe('applierReducer live thinking toggles', () => {
  it('collapses at end-of-thinking and turn end by default', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('thinking.delta', 2, { delta: 'hmm' }),
    )
    expect(s.live?.thinkingOpen).toBe(true)

    s = apply(s, ev('thinking.end', 3))
    expect(s.live?.thinkingOpen).toBe(false)

    // painted thinking stays through turn end and closes with it
    s = apply(s, ev('turn.end', 4, { stop: 'end_turn' }))
    expect(s.live?.thinking).toBe('hmm')
    expect(s.live?.thinkingOpen).toBe(false)
  })

  it('re-expands a fresh stream the user never touched', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('thinking.delta', 2, { delta: 'one' }),
      ev('thinking.end', 3),
      // a running call keeps the buffer alive across the handoff
      ev('tool.start', 4, { id: 'c1', name: 'bash', input: '{}' }),
    )
    expect(s.live?.thinkingOpen).toBe(false)

    // the step's entry commits; the committed thinking drains from it
    const committed = assistantWith([
      { type: 'thinking', data: { text: 'one' } },
      { type: 'tool_call', data: { id: 'c1', name: 'bash' } },
    ])
    s = apply(s, ev('entry.append', 5, { entry: committed }))
    expect(s.live?.thinking).toBe('')

    // the next step's stream mounts expanded again, like a new buffer would
    s = apply(s, ev('thinking.delta', 6, { delta: 'two' }))
    expect(s.live?.thinkingOpen).toBe(true)
    expect(s.live?.thinking).toBe('two')
  })

  it('stops applying collapses once the user has toggled', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('thinking.delta', 2, { delta: 'hmm' }),
      { type: 'liveThinkingToggled', open: false },
    )
    expect(s.live).toMatchObject({ thinkingOpen: false, thinkingUserToggled: true })

    // the end-of-thinking collapse no longer snaps shut under them
    s = apply(s, ev('thinking.end', 3))
    expect(s.live?.thinkingOpen).toBe(false)

    // reopening keeps ownership through turn end and later streams
    s = apply(s, { type: 'liveThinkingToggled', open: true })
    expect(s.live?.thinkingOpen).toBe(true)
    s = apply(s, ev('turn.end', 4, { stop: 'end_turn' }))
    expect(s.live?.thinkingOpen).toBe(true)
    s = apply(s, ev('thinking.delta', 5, { delta: 'more' }))
    expect(s.live?.thinkingOpen).toBe(true)
  })

  it('ignores toggles with no live buffer and converges on replay', () => {
    const empty = apply(initialSessionState(), { type: 'liveThinkingToggled', open: true })
    expect(empty.live).toBeNull()

    // a recorded toggle replays to the same state object
    let s = apply(initialSessionState(), ev('turn.start', 1, { model: 'm' }))
    s = apply(s, { type: 'liveThinkingToggled', open: false })
    expect(apply(s, { type: 'liveThinkingToggled', open: false })).toBe(s)
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

describe('applierReducer seat state', () => {
  it('reads swarm displacement as our own takeover', () => {
    // swarm force-claiming announces loss to the previous holder; this
    // single-user service is the new holder, so SeatBadge clears at once.
    const s = apply(initialSessionState(), ev('seat.lost', 1, { from: 'human-2', to: 'swarm' }))
    expect(s.snapshot.seat).toEqual({ held: true, holder: 'swarm', yours: true })
  })

  it('merges seat through resnapshots like poll-only facts', () => {
    // A seat release spends no event number; the next snapshot is where the
    // badge learns it.
    let s = apply(initialSessionState(), ev('seat.lost', 1, { from: 'swarm', to: 'human-2' }))
    expect(s.snapshot.seat).toEqual({ held: true, holder: 'human-2', yours: false })

    s = apply(s, { type: 'snapshot', state: snap({ seq: 1, seat: { held: false, yours: false } }) })
    expect(s.snapshot.seat).toEqual({ held: false, yours: false })

    const taken = snap({ seq: 2, seat: { held: true, holder: 'swarm', yours: true } })
    s = apply(s, { type: 'snapshot', state: taken })
    expect(s.snapshot.seat).toEqual({ held: true, holder: 'swarm', yours: true })
  })

  it('refreshes seat even from a stale snapshot stamp', () => {
    // Poll-only semantics match workspace and cwd: an in-flight read taken
    // before the displacement still lands, and the next poll corrects any race.
    let s = apply(initialSessionState(), ev('seat.lost', 5, { from: 'swarm', to: 'human-2' }))
    s = apply(s, {
      type: 'snapshot',
      state: snap({ seq: 4, seat: { held: false, yours: false } }),
    })
    expect(s.snapshot.seat).toEqual({ held: false, yours: false })
  })
})

describe('applierReducer snapshot ordering', () => {
  const dialog = (id: number) => ({
    id,
    kind: 'confirm',
    prompt: 'Allow write access?',
    options: ['allow', 'deny'],
  })

  it('stale stamp keeps event state', () => {
    // The poll fired, then the stream announced a dialog and queue rows; the
    // in-flight response read before all that and must not empty them.
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('interaction.pending', 2, dialog(7)),
      ev('status', 3, { spinning: true }),
      ev('queued', 4, { rows: [{ id: 'c1', text: 'one' }] }),
    )
    s = apply(s, {
      type: 'snapshot',
      state: snap({
        seq: 2,
        session: { id: s.snapshot.session.id, name: 'older' },
        spinning: false,
        interactions: [],
        queuedRows: [],
        queued: 0,
      }),
    })
    expect(s.snapshot.interactions).toEqual([dialog(7)]) // the dialog stays answerable
    expect(s.snapshot.queuedRows).toEqual([{ id: 'c1', text: 'one' }])
    expect(s.snapshot.spinning).toBe(true)
    expect(s.snapshot.session.name).toBeUndefined() // no rename regression either
  })

  it('fresh stamp lands event state', () => {
    let s = apply(initialSessionState(), ev('interaction.pending', 1, dialog(7)))
    // The read folded the settle that is still in flight to us.
    s = apply(s, { type: 'snapshot', state: snap({ seq: 2, interactions: [] }) })
    expect(s.snapshot.interactions).toEqual([])

    // A later event below a fresher read cannot resurrect anything either way.
    s = apply(s, ev('interaction.pending', 1, dialog(7)))
    expect(s.snapshot.interactions).toEqual([])
  })

  it('stale stamp keeps queued pendings waiting', () => {
    let s = apply(initialSessionState(), { type: 'pendingSubmitted', pendingId: 'p1', text: 'hi' })
    s = apply(s, ev('queued', 2, { rows: [{ id: 'p1', text: 'hi' }] }))
    s = apply(s, {
      type: 'snapshot',
      state: snap({ seq: 1, queuedRows: [], queued: 0 }),
    })
    expect(s.pendings[0]?.state).toBe('queued') // a stale read never resolves rows
  })

  it('stale stamp keeps a running turn live', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 5, { model: 'm' }),
      ev('tool.output', 6, { id: 'c1', delta: 'partial out' }),
    )
    // The read predates the turn; it must not retire its freshly streamed card.
    s = apply(s, { type: 'snapshot', state: snap({ seq: 4, running: false }) })
    expect(s.live?.tools[0]?.outputs).toEqual(['partial out'])

    // A read at least as fresh as the stream retires what no event closed.
    s = apply(s, { type: 'snapshot', state: snap({ seq: 7, running: false }) })
    expect(s.live).toBeNull()
  })
})

describe('applierReducer diff anchoring', () => {
  it('records the chain tail as its anchor at arrival', () => {
    const root = messageEntry('01A', undefined, 'user', 'hello')
    const reply = messageEntry('01B', '01A', 'assistant', 'hi there')
    let s = apply(initialSessionState(), {
      type: 'init',
      frame: initFrame(snap({ head: '01B' }), [root, reply]),
    })

    s = apply(
      s,
      ev('diff', 5, { path: 'src/main.go', before: 'one\ntwo\n', after: 'one\nTHREE\n' }),
    )
    expect(s.diffs).toEqual([
      { path: 'src/main.go', before: 'one\ntwo\n', after: 'one\nTHREE\n', afterId: '01B' },
    ])
  })

  it('anchors nowhere before any committed entry', () => {
    const s = apply(initialSessionState(), ev('diff', 1, { path: 'f', before: '', after: 'x' }))
    expect(s.diffs[0]?.afterId).toBe('')
  })

  it('keeps earlier anchors still while later diffs reach the new tail', () => {
    const root = messageEntry('01A', undefined, 'user', 'hello')
    let s = apply(initialSessionState(), {
      type: 'init',
      frame: initFrame(snap({ head: '01A' }), [root]),
    })

    s = apply(s, ev('diff', 1, { path: 'a.txt', before: '', after: 'one' }))
    const reply = messageEntry('01B', '01A', 'assistant', 'hi there')
    s = apply(s, ev('entry.append', 2, { entry: reply }))
    s = apply(s, ev('diff', 3, { path: 'b.txt', before: '', after: 'two' }))

    expect(s.diffs.map((d) => d.afterId)).toEqual(['01A', '01B'])
  })

  it('keeps the diff list bounded at ten', () => {
    let s = initialSessionState()
    for (let i = 1; i <= 11; i++) s = apply(s, ev('diff', i, { path: `f${i}` }))
    expect(s.diffs).toHaveLength(10)
    // the oldest drops, the newest survives
    expect(s.diffs[0]?.path).toBe('f2')
  })
})

// assistantWith builds one committed message entry with arbitrary blocks;
// role defaults to assistant, which is what the echo rules drain.
function assistantWith(content: unknown[], role = 'assistant'): Entry {
  return entry(
    '01A',
    undefined,
    'message',
    JSON.parse(JSON.stringify({ message: { role, content } })),
  )
}

// flushEntry builds the injected message a staged run's flush commits, the
// shape ajent's shellUserMessage writes.
function flushEntry(id: string, cmd: string): Entry {
  return entry(id, undefined, 'message', {
    message: {
      role: 'user',
      content: [{ type: 'text', data: { text: `User Ran: ${cmd}\n\nOutput:\nbuilt` } }],
    },
    injected: true,
    replayed: true,
  })
}

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

describe('applierReducer mid-turn exit', () => {
  // upstream flips the spinner with the turn, and a bounded teardown can exit
  // before the turn settles: no turn.end and no spinner flip ever follow
  const midTurn = [
    ev('turn.start', 1, { model: 'm' }),
    ev('status', 2, { spinning: true }),
    ev('thinking.delta', 3, { delta: 'hmm' }),
    ev('tool.start', 4, { id: 'c1', name: 'bash', input: '{}' }),
    ev('tool.output', 5, { id: 'c1', delta: 'partial out' }),
  ]

  it('ends the open turn exactly like turn.end', () => {
    const exited = apply(
      initialSessionState(),
      ...midTurn,
      ev('session.exit', 6, { reason: 'unsettled' }),
    )
    const ended = apply(initialSessionState(), ...midTurn, ev('turn.end', 6, { stop: 'end_turn' }))

    // identical turn state plus the reason; only the spinner also dies
    expect(exited.exitReason).toBe('unsettled')
    expect(ended.exitReason).toBeUndefined()
    expect(exited.live).toEqual(ended.live)
    expect(exited.snapshot).toEqual({ ...ended.snapshot, spinning: false })
    expect(exited.lastTurnEndAt).toBeGreaterThan(0)
    // painted content stays and the stranded call never shows running again
    expect(exited.live?.tools[0]).toMatchObject({ id: 'c1', closed: true })
    expect(exited.live?.tools[0].outputs).toEqual(['partial out'])
    // the stop affordance releases: nothing is busy anymore
    expect(sessionBusy(exited.snapshot)).toBe(false)
    expect(sessionBusy(ended.snapshot)).toBe(true)
  })

  it('stays settled when turn.end arrived before the exit', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('text.delta', 2, { delta: 'partial' }),
      ev('turn.end', 3, { stop: 'end_turn' }),
    )
    const sealed = s.live
    s = apply(s, ev('session.exit', 4, { reason: 'done' }))
    expect(s.exitReason).toBe('done')
    expect(s.live).toEqual(sealed) // the closed buffer is untouched
    expect(s.snapshot.running).toBe(false)
  })

  it('leaves a resting session exactly as before', () => {
    const s = apply(initialSessionState(), ev('session.exit', 1, {}))
    expect(s.exitReason).toBe('')
    expect(s.live).toBeNull()
    expect(s.snapshot.running).toBe(false)
  })

  it('keeps a raced resnapshot from resurrecting busy state', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('status', 2, { spinning: true }),
      ev('session.exit', 3, { reason: 'sigterm' }),
    )
    // the read raced the exit: its stamp is fresh but its facts are stale
    s = apply(s, { type: 'snapshot', state: snap({ seq: 3, running: true, spinning: true }) })
    expect(s.snapshot.running).toBe(false)
    expect(s.snapshot.spinning).toBe(false)

    // poll-only facts still merge for the ended run
    s = apply(s, {
      type: 'snapshot',
      state: snap({
        seq: 4,
        usage: { turns: 9, total: zeroUsage(), child: zeroUsage(), estimatedTurns: 0 },
      }),
    })
    expect(s.snapshot.usage.turns).toBe(9)
  })
})

describe('applierReducer tool card state', () => {
  it('force-closes running cards at turn.end instead of discarding them', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
      ev('tool.output', 3, { id: 'c1', delta: 'partial out' }),
    )
    expect(s.live?.tools).toHaveLength(1)

    s = apply(s, ev('turn.end', 4, { stop: 'aborted', steps: 1 }))
    // the card keeps its painted output and never shows running again
    const [card] = s.live?.tools ?? []
    expect(card.closed).toBe(true)
    expect(card.result).toBeUndefined()
    expect(s.snapshot.running).toBe(false)
  })

  it('failed results surface the fault-location notice text', () => {
    const faultNotice = 'tool panicked: boom (pkg/tools/run.go:42)'
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
      // upstream emits the recover notice immediately before the result
      ev('notice', 3, { text: faultNotice, level: 'error' }),
      ev('tool.result', 4, { id: 'c1', output: 'tool panicked: boom', error: true }),
    )
    expect(s.live?.tools[0]?.result?.fault).toBe(faultNotice)

    // an unrelated error notice never attaches
    s = apply(
      initialSessionState(),
      ev('notice', 1, { text: 'disk nearly full', level: 'error' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
      ev('tool.result', 3, { id: 'c1', output: 'tool panicked: boom', error: true }),
    )
    expect(s.live?.tools[0]?.result?.fault).toBeUndefined()
  })

  it('resnapshot retires stranded buffers once idle', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
      ev('tool.output', 3, { id: 'c1', delta: 'partial out' }),
    )

    // the carrier entry and turn.end never arrived; the snapshot says idle
    s = apply(s, { type: 'snapshot', state: snap({ running: false }) })
    expect(s.live).toBeNull()

    // a stranded card with nothing painted retires the same way, and
    // committed history tells what happened
    let bare = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
    )
    bare = apply(bare, { type: 'snapshot', state: snap({ running: false }) })
    expect(bare.live).toBeNull()
  })

  it('resnapshot clears sealed thinking residue once idle', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('thinking.delta', 2, { delta: 'hmm' }),
      ev('text.delta', 3, { delta: 'partial' }),
      // turn.end seals the buffer and painted content stays for the handoff
      ev('turn.end', 4, { stop: 'end_turn' }),
    )
    expect(s.live?.thinking).toBe('hmm')
    expect(s.live?.text).toBe('partial')

    // the commit never drained here, but the not-running snapshot retires the
    // residue outright: committed entries own the content from that point
    s = apply(s, { type: 'snapshot', state: snap({ seq: 5, running: false }) })
    expect(s.live).toBeNull()
  })

  it('resnapshot leaves a live turn alone while one is running', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
    )
    s = apply(s, { type: 'snapshot', state: snap({ running: true }) })
    expect(s.live?.tools[0]?.closed).toBeUndefined()
  })

  it('folds committed results keyed by either spelling', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
    )
    const assistant = entry(
      '01ASSIST0000000000',
      undefined,
      'message',
      JSON.parse(
        JSON.stringify({
          message: {
            role: 'assistant',
            content: [{ type: 'tool_call', data: { id: 'c1', name: 'bash' } }],
          },
        }),
      ),
    )
    // the carrier names the call with `id`, not `callId`
    const carrier = entry(
      '01CARRIER000000000',
      undefined,
      'message',
      JSON.parse(
        JSON.stringify({
          message: {
            role: 'user',
            content: [{ type: 'tool_result', data: { id: 'c1', content: [] } }],
          },
        }),
      ),
    )
    s = apply(s, ev('entry.append', 3, { entry: assistant }))
    expect(s.live?.tools).toHaveLength(1) // header alone still paints live
    s = apply(s, ev('entry.append', 4, { entry: carrier }))
    expect(s.live).toBeNull() // the id-keyed result folds and retires the card
  })

  it('backfilled carriers reconcile stranded cards too', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
      ev('tool.output', 3, { id: 'c1', delta: 'partial out' }),
    )
    const carrier = entry(
      '01CARRIER000000000',
      undefined,
      'message',
      JSON.parse(
        JSON.stringify({
          message: {
            role: 'user',
            content: [{ type: 'tool_result', data: { callId: 'c1', content: [] } }],
          },
        }),
      ),
    )
    // the carrier arrives through a heal-by-paging backfill, not live
    s = apply(s, { type: 'backfill', entries: [carrier] })
    expect(s.live).toBeNull()
  })
})

describe('applierReducer user shell cards', () => {
  // shellStart builds one staged-run tool.start, transcribed from what ajent's
  // stager publishes: a bang label with full display.
  const shellStart = (seq: number, id: string, label: string): WireEvent =>
    ev('tool.start', seq, {
      id,
      name: 'bash',
      input: '{"command":"make test"}',
      label,
      full: true,
    })

  it('marks a card user-shell from its bang label', () => {
    const s = apply(
      initialSessionState(),
      shellStart(1, 'shell-1', '! make test'),
      ev('tool.start', 2, { id: 'call9', name: 'bash', input: '{}', label: 'bash: ls' }),
    )
    expect(s.live?.tools[0]).toMatchObject({ id: 'shell-1', shell: true, label: '! make test' })
    // an agent call keeps its plain header even when it carries a label
    expect(s.live?.tools[1]?.shell).toBeUndefined()
    expect(s.live?.tools[1]?.label).toBeUndefined()
  })

  it('marks a double-bang card excluded from context', () => {
    const s = apply(
      initialSessionState(),
      shellStart(1, 'shell-1', '!! git status'),
      shellStart(2, 'shell-2', '! make test'),
    )
    // excluded implies shell, so the card survives turns and retires by label
    expect(s.live?.tools[0]).toMatchObject({ shell: true, excluded: true })
    expect(s.live?.tools[1]?.excluded).toBeUndefined()
  })

  it('keeps an unfinished shell buffer across a not-running resnapshot', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('text.delta', 2, { delta: 'residue' }),
      ev('tool.start', 3, { id: 'c1', name: 'bash', input: '{}' }),
      shellStart(4, 'shell-1', '! make test'),
      ev('tool.output', 5, { id: 'shell-1', delta: 'building...' }),
      ev('turn.end', 6, { stop: 'end_turn' }),
    )
    // the model call seals at turn end; the staged run outlives the turn
    expect(s.live?.tools.find((t) => t.id === 'c1')?.closed).toBe(true)
    expect(s.live?.tools.find((t) => t.id === 'shell-1')?.closed).toBeUndefined()

    s = apply(s, { type: 'snapshot', state: snap({ running: false }) })
    expect(s.live).not.toBeNull()
    // the sealed turn residue drops, the still-running shell card stays
    expect(s.live?.text).toBe('')
    expect(s.live?.tools).toHaveLength(1)
    expect(s.live?.tools[0]).toMatchObject({ id: 'shell-1', shell: true })
  })

  it('retires the finished card when its flush entry commits', () => {
    let s = apply(
      initialSessionState(),
      shellStart(1, 'shell-1', '! make test'),
      ev('tool.result', 2, { id: 'shell-1', name: 'bash', output: 'built' }),
    )
    s = apply(s, ev('entry.append', 3, { entry: flushEntry('01FLUSH00000000000', 'make test') }))
    expect(s.live).toBeNull()
  })

  it('clears only the flushed command among several cards', () => {
    let s = apply(
      initialSessionState(),
      shellStart(1, 'shell-1', '! make test'),
      ev('tool.result', 2, { id: 'shell-1', name: 'bash', output: 'built' }),
      shellStart(3, 'shell-2', '!! git status'),
      ev('tool.result', 4, { id: 'shell-2', name: 'bash', output: 'clean' }),
    )
    s = apply(s, ev('entry.append', 5, { entry: flushEntry('01FLUSH00000000000', 'make test') }))
    expect(s.live?.tools.map((t) => t.id)).toEqual(['shell-2'])

    // a typed prompt quoting the marker clears nothing: only flushes do
    const typed = messageEntry('01PROMPT00000000000', undefined, 'user', 'User Ran: git status')
    s = apply(s, ev('entry.append', 6, { entry: typed }))
    expect(s.live?.tools.map((t) => t.id)).toEqual(['shell-2'])
  })

  it('clears through a backfilled flush too', () => {
    let s = apply(
      initialSessionState(),
      shellStart(1, 'shell-1', '!! git status'),
      ev('tool.result', 2, { id: 'shell-1', name: 'bash', output: 'clean' }),
    )
    // the flush lands through a heal-by-paging backfill, not a live append
    s = apply(s, { type: 'backfill', entries: [flushEntry('01FLUSH00000000000', 'git status')] })
    expect(s.live).toBeNull()
  })

  it('drops the oldest `!!` cards past the count cap', () => {
    let s = initialSessionState()
    for (let i = 1; i <= 7; i++) {
      s = apply(s, shellStart(i, `shell-${i}`, `!! cmd ${i}`))
    }
    // excluded runs never flush, so the newest five are all that stay
    expect(s.live?.tools.map((t) => t.id)).toEqual([
      'shell-3',
      'shell-4',
      'shell-5',
      'shell-6',
      'shell-7',
    ])
  })
})

describe('applierReducer permit verdict notices', () => {
  it('rides the running card instead of stacking', () => {
    const s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
      // upstream resolves the gate between this call's start and result
      ev('notice', 3, { text: 'Tool auto allowed', level: 'info' }),
    )
    expect(s.notices).toHaveLength(0)
    expect(s.live?.tools[0]?.verdict).toBe('auto allowed')
    expect(s.permitVerdicts).toEqual([{ id: 'c1', text: 'auto allowed' }])
  })

  it('covers session and once grants too', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
      ev('notice', 3, { text: 'Tool allowed for session', level: 'info' }),
    )
    expect(s.live?.tools[0]?.verdict).toBe('allowed for session')

    s = apply(
      s,
      ev('tool.result', 4, { id: 'c1', output: 'ok' }),
      ev('tool.start', 5, { id: 'c2', name: 'bash', input: '{}' }),
      ev('notice', 6, { text: 'Tool call allowed this time', level: 'info' }),
    )
    expect(s.live?.tools[1]?.verdict).toBe('allowed this time')
    expect(s.permitVerdicts).toHaveLength(2)
  })

  it('targets the newest open call in a parallel batch', () => {
    const s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'read', input: '{}' }),
      ev('tool.start', 3, { id: 'c2', name: 'bash', input: '{}' }),
      // parallel launches race their gates, and the newest open call is the
      // only subject a bare verdict line can name
      ev('notice', 4, { text: 'Tool auto allowed', level: 'info' }),
    )
    expect(s.live?.tools[0]?.verdict).toBeUndefined()
    expect(s.live?.tools[1]?.verdict).toBe('auto allowed')
  })

  it('falls back to a notice without an open card', () => {
    const s = apply(initialSessionState(), ev('notice', 1, { text: 'Tool auto allowed' }))
    expect(s.notices).toHaveLength(1)
    expect(s.permitVerdicts).toHaveLength(0)
  })

  it('keeps unrelated notices on the notice path', () => {
    const s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'bash', input: '{}' }),
      ev('notice', 3, { text: 'Sub-agent sub-6 completed', level: 'info' }),
    )
    expect(s.live?.tools[0]?.verdict).toBeUndefined()
    expect(s.notices).toHaveLength(1)
  })
})

describe('applierReducer echo fidelity', () => {
  it('drains streamed text and thinking when the entry commits', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('thinking.delta', 2, { delta: 'hmm' }),
      ev('text.delta', 3, { delta: 'Hello ' }),
      ev('text.delta', 4, { delta: 'streamed world' }),
    )
    expect(s.live?.text).toBe('Hello streamed world')

    const committed = assistantWith([
      { type: 'thinking', data: { text: 'hmm' } },
      { type: 'text', data: { text: 'Hello streamed world' } },
    ])
    s = apply(s, ev('entry.append', 5, { entry: committed }))
    // the buffer empties instead of double-rendering at turn end
    expect(s.live).toBeNull()
  })

  it('retires a live tool card when its carrier commits', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('tool.start', 2, { id: 'c1', name: 'read_file', input: '{}' }),
      ev('tool.output', 3, { id: 'c1', delta: 'contents' }),
    )
    expect(s.live?.tools).toHaveLength(1)

    const assistant = assistantWith([{ type: 'tool_call', data: { id: 'c1', name: 'read_file' } }])
    s = apply(s, ev('entry.append', 4, { entry: assistant }))
    // between the call's commit and its results, the live card still paints
    expect(s.live?.tools).toHaveLength(1)

    const carrier = assistantWith(
      [{ type: 'tool_result', data: { callId: 'c1', content: [] } }],
      'user',
    )
    s = apply(s, ev('entry.append', 5, { entry: carrier }))
    // the drained buffer retires entirely once nothing is left to paint
    expect(s.live).toBeNull()
  })

  it('drains every same-family block when several commit together', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('text.delta', 2, { delta: 'before toolafter tool' }),
    )
    const committed = assistantWith([
      { type: 'text', data: { text: 'before tool' } },
      { type: 'tool_call', data: { id: 'c1', name: 'bash' } },
      { type: 'text', data: { text: 'after tool' } },
    ])
    s = apply(s, ev('entry.append', 3, { entry: committed }))
    // both painted copies drain, not just the one ending the buffer
    expect(s.live).toBeNull()
  })

  it('keeps streamed text when the committed entry carries something new', () => {
    let s = apply(
      initialSessionState(),
      ev('turn.start', 1, { model: 'm' }),
      ev('text.delta', 2, { delta: 'streamed' }),
    )
    const committed = assistantWith([{ type: 'text', data: { text: 'committed' } }])
    s = apply(s, ev('entry.append', 3, { entry: committed }))
    // a mismatch leaves the painted prefix; nothing is lost
    expect(s.live?.text).toBe('streamed')
  })
})
