import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { applierReducer, initialSessionState } from '../state/eventApplier'
import type { ApplierAction, AppliedSessionState } from '../state/eventApplier'
import { ev, initFrame, messageEntry, testState } from '../state/testFixtures'
import { TurnEndAnnouncement } from './TurnEndAnnouncement'

// The turn-end announcement both session surfaces host: one polite line when a
// streamed turn retires, naming the reply's first line, and silence for
// everything that is not that -- streaming, mounting, rebuilt state,
// prepending, rewinding, exiting.

const user = (id: string, parent: string | undefined, text: string) =>
  messageEntry(id, parent, 'user', text)
const reply = (id: string, parent: string | undefined, text: string) =>
  messageEntry(id, parent, 'assistant', text)

const history = (head: string, ...entries: ReturnType<typeof messageEntry>[]) => ({
  type: 'init' as const,
  frame: initFrame(testState({ head }), entries),
})

// mount hosts one state slot and replays reducer actions between renders the
// way the channel does.
function mount(initial: AppliedSessionState) {
  let current = initial
  const draw = () => <TurnEndAnnouncement state={current} />
  const view = render(draw())
  return {
    text: () => screen.getByRole('status').textContent,
    apply(...actions: ApplierAction[]) {
      current = actions.reduce(applierReducer, current)
      view.rerender(draw())
    },
  }
}

// idle is a session holding one committed prompt and nothing in flight
function idle(): AppliedSessionState {
  return applierReducer(initialSessionState(), history('u1', user('u1', undefined, 'explain')))
}

// retire streams one whole turn: start, a committed answer, end
function retire(seq: number, id: string, text: string): ApplierAction[] {
  return [
    { type: 'event', event: ev('turn.start', seq, { model: 'sonnet' }) },
    { type: 'event', event: ev('entry.append', seq + 1, { entry: reply(id, 'u1', text) }) },
    { type: 'event', event: ev('turn.end', seq + 2, { stop: 'end_turn' }) },
  ]
}

describe('TurnEndAnnouncement', () => {
  it('stays silent on mount over committed history', () => {
    const settled = applierReducer(
      idle(),
      history('a1', user('u1', undefined, 'explain'), reply('a1', 'u1', 'Old answer.')),
    )
    const view = mount(settled)

    // history the view opened on is not a reply that just landed
    expect(view.text()).toBe('')
  })

  it('stays silent when the init frame lands after mount', () => {
    // the real flow: the surface mounts on an empty state and the init frame
    // brings the session's whole transcript, settled replies included
    const view = mount(initialSessionState())

    view.apply(history('a1', user('u1', undefined, 'explain'), reply('a1', 'u1', 'Old answer.')))

    expect(view.text()).toBe('')
  })

  it('stays silent when a turn commits no reply over history', () => {
    // the history above is never a pending answer: an interrupted or failed
    // first turn retires with nothing of its own to read
    const view = mount(initialSessionState())
    view.apply(history('a1', user('u1', undefined, 'explain'), reply('a1', 'u1', 'Old answer.')))

    view.apply(
      { type: 'event', event: ev('turn.start', 1, { model: 'sonnet' }) },
      { type: 'event', event: ev('turn.end', 2, { stop: 'aborted' }) },
    )

    expect(view.text()).toBe('')
  })

  it('reads a turn that ran whole between two renders', () => {
    // frames landing in one batch still read: the watermark moved, so the
    // reply is a wire event's and not a rebuilt state
    const view = mount(idle())

    view.apply(...retire(1, 'a1', 'Whole turn.'))

    expect(view.text()).toBe('Assistant replied: Whole turn.')
  })

  it('stays silent when a resync rebuilds the transcript', () => {
    const view = mount(idle())
    view.apply({ type: 'event', event: ev('notice', 1, { text: 'an event moves the watermark' }) })

    // a reconnect's init replays everything plus a reply that landed away
    view.apply(
      history('a1', user('u1', undefined, 'explain'), reply('a1', 'u1', 'Answered while away.')),
    )

    expect(view.text()).toBe('')
  })

  it('reads the turn it joined mid-stream once that turn retires', () => {
    // mounting into a running turn is not a reply; watching it retire is
    const running = applierReducer(idle(), {
      type: 'event',
      event: ev('turn.start', 1, { model: 'sonnet' }),
    })
    const view = mount(running)

    view.apply(
      { type: 'event', event: ev('text.delta', 2, { delta: 'Joined answer.' }) },
      {
        type: 'event',
        event: ev('entry.append', 3, { entry: reply('a1', 'u1', 'Joined answer.') }),
      },
      { type: 'event', event: ev('turn.end', 4, { stop: 'end_turn' }) },
    )

    expect(view.text()).toBe('Assistant replied: Joined answer.')
  })

  it('reads the first line of the reply once a streamed turn retires', () => {
    const view = mount(idle())

    view.apply(
      { type: 'event', event: ev('turn.start', 1, { model: 'sonnet' }) },
      { type: 'event', event: ev('text.delta', 2, { delta: 'The answer.\n\nMore detail.' }) },
      {
        type: 'event',
        event: ev('entry.append', 3, { entry: reply('a1', 'u1', 'The answer.\n\nMore detail.') }),
      },
    )
    // the answer committed but the turn still runs: nothing reads yet
    expect(view.text()).toBe('')

    view.apply({ type: 'event', event: ev('turn.end', 4, { stop: 'end_turn' }) })
    expect(view.text()).toBe('Assistant replied: The answer.')
  })

  it('reads the final answer of a multi-step turn once', () => {
    const view = mount(idle())

    view.apply(
      { type: 'event', event: ev('turn.start', 1, { model: 'sonnet' }) },
      { type: 'event', event: ev('text.delta', 2, { delta: 'Checking.' }) },
      { type: 'event', event: ev('entry.append', 3, { entry: reply('a1', 'u1', 'Checking.') }) },
    )
    expect(view.text()).toBe('')

    view.apply(
      { type: 'event', event: ev('text.delta', 4, { delta: 'All done.' }) },
      { type: 'event', event: ev('entry.append', 5, { entry: reply('a2', 'a1', 'All done.') }) },
      { type: 'event', event: ev('turn.end', 6, { stop: 'end_turn' }) },
    )
    // the intermediate step never reads on its own
    expect(view.text()).toBe('Assistant replied: All done.')
  })

  it('reads the reply while a staged shell card outlives the turn', () => {
    // a `!` run keeps painting past turn.end, its card is no turn in flight
    const view = mount(idle())

    view.apply(
      { type: 'event', event: ev('turn.start', 1, { model: 'sonnet' }) },
      { type: 'event', event: ev('tool.start', 2, { id: 'c1', name: 'bash', label: '! make' }) },
      { type: 'event', event: ev('entry.append', 3, { entry: reply('a1', 'u1', 'Building.') }) },
      { type: 'event', event: ev('turn.end', 4, { stop: 'end_turn' }) },
    )

    expect(view.text()).toBe('Assistant replied: Building.')
  })

  it('reads a reply that lands right after turn end', () => {
    const view = mount(idle())

    view.apply(
      { type: 'event', event: ev('turn.start', 1, { model: 'sonnet' }) },
      { type: 'event', event: ev('turn.end', 2, { stop: 'end_turn' }) },
    )
    expect(view.text()).toBe('')

    view.apply({
      type: 'event',
      event: ev('entry.append', 3, { entry: reply('a1', 'u1', 'Late.') }),
    })
    expect(view.text()).toBe('Assistant replied: Late.')
  })

  it('clears when the next turn starts, so an equal reply reads again', () => {
    const view = mount(idle())
    view.apply(...retire(1, 'a1', 'Done.'))
    expect(view.text()).toBe('Assistant replied: Done.')

    // the region empties at turn.start, so the same text later is a change
    view.apply({ type: 'event', event: ev('turn.start', 4, { model: 'sonnet' }) })
    expect(view.text()).toBe('')
  })

  it('cuts a long first line to the bound and skips leading blanks', () => {
    const long = 'x'.repeat(200)
    const view = mount(idle())

    view.apply(...retire(1, 'a1', `\n\n${long}`))
    expect(view.text()).toBe(`Assistant replied: ${'x'.repeat(120)}…`)
  })

  it('stays silent when the run exits mid-turn', () => {
    const view = mount(idle())

    view.apply(
      { type: 'event', event: ev('turn.start', 1, { model: 'sonnet' }) },
      { type: 'event', event: ev('entry.append', 2, { entry: reply('a1', 'u1', 'Half way.') }) },
      { type: 'event', event: ev('session.exit', 3, { reason: 'sigterm' }) },
    )
    // the ended banner speaks for the run, a cut turn is not a reply
    expect(view.text()).toBe('')
  })

  it('stays silent on an older-history prepend', () => {
    const view = mount(idle())

    view.apply({ type: 'backfill', entries: [user('u0', undefined, 'older prompt')] })

    expect(view.text()).toBe('')
  })

  it('stays silent on a rewind', () => {
    const settled = applierReducer(idle(), {
      type: 'event',
      event: ev('entry.append', 1, { entry: reply('a1', 'u1', 'Old answer.') }),
    })
    const view = mount(settled)

    view.apply({ type: 'event', event: ev('branch.changed', 2, { head: 'u1' }) })

    expect(view.text()).toBe('')
  })

  it('ignores a tool-only step committed mid-turn', () => {
    const call = {
      id: 'a1',
      parentId: 'u1',
      type: 'message',
      ts: 1,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', data: { id: 'c1', name: 'read_file' } }],
        },
      },
    }
    const view = mount(idle())

    view.apply(
      { type: 'event', event: ev('turn.start', 1, { model: 'sonnet' }) },
      { type: 'event', event: ev('entry.append', 2, { entry: call }) },
      { type: 'event', event: ev('turn.end', 3, { stop: 'tool_use' }) },
    )
    // no text was ever committed, so there is nothing to read
    expect(view.text()).toBe('')
  })
})
