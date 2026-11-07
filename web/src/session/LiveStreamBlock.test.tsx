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

    // reopening reports ownership; the matching intent never rewrites the DOM
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

  it('keeps sub-agent rows on a resolved poll card while siblings still run', () => {
    // A poll timeout lands as the card's result; its job and any sibling stay
    // live until upstream clears their rows.
    render(
      <LiveStreamBlock
        live={liveFor({
          tools: [
            {
              id: 'p1',
              name: 'agent_poll',
              outputs: [],
              result: { output: 'sub-agent sub-2 still running after 3m', error: false },
            },
          ],
        })}
        activity={[{ key: 'sub-2', text: 'sub-2  reading files', rank: 2 }]}
      />,
    )
    const poll = document.querySelector('[data-tool-id="p1"]')!
    expect(poll.querySelector('.badge.ok')).toBeInTheDocument()
    expect(poll.querySelector('.subagent-state')).toBeInTheDocument()
  })
})
