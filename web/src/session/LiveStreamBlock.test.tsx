import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LiveStreamBlock } from './LiveStreamBlock'
import type { LiveTurn } from '../state/eventApplier'

// The live thinking panel renders uncontrolled: manual toggles survive every
// render and only a flip of the applier's intent is written through. rAF runs
// synchronously here so each rerender commits its throttled value at once.
// The committed block owns the resting defaults (expanded while live,
// collapsed at handoff), so this file covers only the pinned row.

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => vi.unstubAllGlobals())

function liveFor(overrides: Partial<LiveTurn> = {}): LiveTurn {
  return {
    model: 'sonnet',
    thinking: '',
    thinkingOpen: true,
    text: '',
    textOpen: true,
    tools: [],
    ...overrides,
  }
}

function thinkingPanel(): HTMLDetailsElement | null {
  return screen.getByText('thinking…').closest('details')
}

describe('LiveStreamBlock thinking panel', () => {
  it('mounts expanded from the applier intent', () => {
    render(<LiveStreamBlock live={liveFor({ thinking: 'hmm' })} />)
    expect(thinkingPanel()?.open).toBe(true)
  })

  it('seeds a remounted stream with the recorded intent', () => {
    const { rerender } = render(<LiveStreamBlock live={liveFor({ thinking: 'one' })} />)

    // step one ends and its content hands off, unmounting the panel
    rerender(<LiveStreamBlock live={liveFor({ thinking: '', thinkingOpen: false })} />)
    expect(screen.queryByText('thinking…')).not.toBeInTheDocument()

    // a mid-turn remount seeds from intent, which is how an applier-recorded
    // user collapse survives the handoff between steps
    rerender(<LiveStreamBlock live={liveFor({ thinking: 'two', thinkingOpen: false })} />)
    expect(thinkingPanel()?.open).toBe(false)
  })

  it('keeps a manual collapse across streaming re-renders', async () => {
    const onThinkingToggle = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <LiveStreamBlock live={liveFor({ thinking: 'hmm' })} onThinkingToggle={onThinkingToggle} />,
    )

    await user.click(screen.getByText('thinking…'))
    // the post-click state rides the callback, not the pre-toggle DOM value
    expect(onThinkingToggle).toHaveBeenCalledWith(false)
    expect(thinkingPanel()?.open).toBe(false)

    // more deltas re-render with unchanged intent: nothing fights the click
    rerender(
      <LiveStreamBlock
        live={liveFor({ thinking: 'hmm and more' })}
        onThinkingToggle={onThinkingToggle}
      />,
    )
    expect(onThinkingToggle).toHaveBeenCalledTimes(1)
    expect(thinkingPanel()?.open).toBe(false)

    // the applier honoring the toggle converges to the same closed panel
    rerender(<LiveStreamBlock live={liveFor({ thinking: 'hmm and more', thinkingOpen: false })} />)
    expect(thinkingPanel()?.open).toBe(false)
  })

  it('follows a collapse flip it did not cause and lets the user reopen', async () => {
    const onThinkingToggle = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <LiveStreamBlock live={liveFor({ thinking: 'hmm' })} onThinkingToggle={onThinkingToggle} />,
    )

    // end-of-thinking collapses an untouched panel through the intent flip
    rerender(
      <LiveStreamBlock
        live={liveFor({ thinking: 'hmm', thinkingOpen: false })}
        onThinkingToggle={onThinkingToggle}
      />,
    )
    expect(thinkingPanel()?.open).toBe(false)

    // reopening reports ownership, the matching intent never rewrites the DOM
    await user.click(screen.getByText('thinking…'))
    expect(onThinkingToggle).toHaveBeenCalledWith(true)
    rerender(<LiveStreamBlock live={liveFor({ thinking: 'hmm', thinkingOpen: true })} />)
    expect(thinkingPanel()?.open).toBe(true)
  })

  it('renders without a panel while nothing streamed yet', () => {
    render(<LiveStreamBlock live={liveFor()} />)
    expect(screen.queryByText('thinking…')).not.toBeInTheDocument()
  })
})

describe('LiveStreamBlock tool cards', () => {
  it('headers a user shell card from its label', () => {
    render(
      <LiveStreamBlock
        live={liveFor({
          tools: [{ id: 'shell-1', name: 'bash', label: '! make test', shell: true, outputs: [] }],
        })}
      />,
    )
    expect(screen.getByText('! make test')).toBeInTheDocument()
    expect(screen.queryByText('bash')).not.toBeInTheDocument()
  })

  it('carries the excluded kind to a finished card', () => {
    render(
      <LiveStreamBlock
        live={liveFor({
          tools: [
            {
              id: 'shell-2',
              name: 'bash',
              label: '!! git status',
              shell: true,
              excluded: true,
              outputs: [],
              result: { output: 'clean', error: false },
            },
          ],
        })}
      />,
    )
    expect(screen.getByText('output not sent to the model')).toBeInTheDocument()
  })

  it('shows a waiting poll card only its own job', () => {
    render(
      <LiveStreamBlock
        live={liveFor({
          tools: [{ id: 'p2', name: 'agent_poll', input: { id: 'sub-2' }, outputs: [] }],
        })}
        activity={[
          { key: 'sub-1', text: 'sub-1  reading files', rank: 1 },
          { key: 'sub-2', text: 'sub-2  scanning tests', rank: 2 },
        ]}
      />,
    )
    const poll = document.querySelector('[data-tool-id="p2"]')!
    const chips = Array.from(poll.querySelectorAll('.sub-agent-chip'))
    expect(chips).toHaveLength(1)
    expect(chips[0].getAttribute('data-sub-key')).toBe('sub-2')
    expect(chips[0].textContent).toBe('sub-2  scanning tests')
  })

  it('hides the poll card line once its result lands', () => {
    // A poll timeout is a landed result: the card goes quiet while the chips
    // band keeps every row until upstream clears it.
    render(
      <LiveStreamBlock
        live={liveFor({
          tools: [
            {
              id: 'p2',
              name: 'agent_poll',
              input: { id: 'sub-2' },
              outputs: [],
              result: { output: 'sub-agent sub-2 still running after 3m', error: false },
            },
          ],
        })}
        activity={[
          { key: 'sub-1', text: 'sub-1  reading files', rank: 1 },
          { key: 'sub-2', text: 'sub-2  scanning tests', rank: 2 },
        ]}
      />,
    )
    const poll = document.querySelector('[data-tool-id="p2"]')!
    expect(poll.querySelector('.badge.ok')).toBeInTheDocument()
    expect(poll.querySelector('.subagent-state')).toBeNull()
    // sibling chips survive, matching upstream row lifetimes
    expect(document.querySelectorAll('.subagent-chips .sub-agent-chip')).toHaveLength(2)
  })

  it('ranks the chips band in submission order', () => {
    // parallel starts race to publish, rank keeps the list in job order
    render(
      <LiveStreamBlock
        live={liveFor()}
        activity={[
          { key: 'sub-3', text: 'sub-3  drafting', rank: 3 },
          { key: 'sub-1', text: 'sub-1  reading', rank: 1 },
        ]}
      />,
    )
    const keys = Array.from(document.querySelectorAll('.subagent-chips .sub-agent-chip')).map((c) =>
      c.getAttribute('data-sub-key'),
    )
    expect(keys).toEqual(['sub-1', 'sub-3'])
  })

  it('caps the chips band with an overflow line', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      key: `sub-${i + 1}`,
      text: `sub-${i + 1}  working`,
      rank: i + 1,
    }))
    render(<LiveStreamBlock live={liveFor()} activity={rows} />)
    const chips = document.querySelectorAll('.subagent-chips .sub-agent-chip')
    expect(chips).toHaveLength(5) // four rows plus the overflow line
    expect(chips[4].textContent).toBe('+2 more')
    expect(chips[0].getAttribute('data-sub-key')).toBe('sub-1') // newest hidden
  })

  it('leaves non-agent cards without job lines', () => {
    render(
      <LiveStreamBlock
        live={liveFor({
          tools: [
            { id: 'b1', name: 'bash', input: { cmd: 'ls' }, outputs: [] },
            { id: 'p2', name: 'agent_poll', input: { id: 'sub-2' }, outputs: [] },
          ],
        })}
        activity={[{ key: 'sub-2', text: 'sub-2  scanning tests', rank: 2 }]}
      />,
    )
    expect(document.querySelector('[data-tool-id="b1"] .subagent-state')).toBeNull()
    expect(document.querySelector('[data-tool-id="p2"] .subagent-state')).not.toBeNull()
  })

  it('threads the pull listing', async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    render(
      <LiveStreamBlock
        live={liveFor({
          tools: [{ id: 'p2', name: 'agent_poll', input: { id: 'sub-2' }, outputs: [] }],
        })}
        activity={[{ key: 'sub-2', text: 'sub-2  scanning tests', rank: 2 }]}
        agentJobs={{
          byId: new Map([['sub-2', { id: 'sub-2', status: 'running', elapsedMs: 1500 }]]),
          available: true,
          stop,
          stopping: false,
        }}
      />,
    )
    // record status rides the chips band, elapsed formats beside it, and the
    // same stop fire answers both surfaces
    expect(document.querySelector('[data-sub-status="running"]')).not.toBeNull()
    expect(screen.getAllByText('2s')).toHaveLength(2)
    const buttons = screen.getAllByRole('button', { name: 'Stop sub-2' })
    expect(buttons).toHaveLength(2) // chips band plus the poll card's own row
    await user.click(buttons[0])
    expect(stop).toHaveBeenCalledWith('sub-2')
  })
})
