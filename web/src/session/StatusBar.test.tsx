import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StatusBar, contextLevel } from './StatusBar'
import { ToolsPanel } from './ToolsPanel'
import type { CtlState } from '../api/types'
import type { LiveTurn } from '../state/eventApplier'

// The status bar renders the streamed segments plus context, queue and
// activity; model and permission mode live in the header, so neither appears
// here. The tools panel offers every registered tool as a toggle — readOnly is
// permission metadata, not a lock — with widen-only state after the first
// prompt rendered as disabled instead of a silent refusal.

function snapFor(overrides: Partial<CtlState> = {}): CtlState {
  return {
    session: { id: '01S' },
    workspace: '/w',
    cwd: '/w',
    head: '',
    model: {
      key: 'anthropic/claude-x',
      short: 'zed-x',
      window: 200_000,
      caps: { reasoning: true, images: false, parallelToolCalls: true },
    },
    permission: 'auto',
    tools: [],
    usage: { turns: 0, total: zero(), child: zero(), estimatedTurns: 0 },
    context: {
      used: 100_000,
      window: 200_000,
      reserve: 10_000,
      compact: 150_000,
      estimated: false,
    },
    running: false,
    idle: true,
    spinning: false,
    queued: 2,
    activity: [],
    status: {
      segments: [
        { key: 'tokens', text: '1.2k tok', short: '1.2k', order: 0 },
        { key: 'path', text: '', order: 1 }, // removals render nothing
      ],
    },
    seat: { held: false, yours: false },
    ...overrides,
  }
}

function zero() {
  return { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

afterEach(() => vi.useRealTimers())

describe('StatusBar segments', () => {
  it('renders streamed segments, queue and activity without header-owned keys', () => {
    render(
      <StatusBar
        snap={snapFor({
          activity: [
            { key: 'sub-1', text: 'sub-1 queued for 2s', rank: 0 },
            { key: 'step', text: 'reading files', rank: 10 },
          ],
          status: {
            segments: [
              { key: 'tokens', text: '1.2k tok', short: '1.2k', order: 0 },
              { key: 'path', text: '', order: 1 }, // removals render nothing
              { key: 'permissions', text: 'auto+write', short: 'auto+w', order: 60 },
            ],
          },
        })}
      />,
    )
    expect(screen.getByText('1.2k')).toBeInTheDocument()
    expect(screen.queryByText(/path/)).not.toBeInTheDocument() // empty removed
    expect(screen.queryByText('auto+write')).not.toBeInTheDocument() // header owns mode
    expect(screen.queryByText('auto+w')).not.toBeInTheDocument() // no short shadow either
    expect(screen.getByText('2 queued')).toBeInTheDocument()
    expect(screen.getByText('reading files')).toBeInTheDocument()
    // sub-agent jobs land in the segment row as a count
    expect(screen.getByText(/1 agent/)).toBeInTheDocument()
  })

  it('leads with the working glyph colored by the turn state', () => {
    const idle = render(<StatusBar snap={snapFor()} />)
    let bar = idle.container.querySelector('.status-bar')!
    expect(bar.firstElementChild?.className).toBe('spinner idle')
    idle.unmount()

    // a turn in flight with nothing streaming back yet is the wait color
    const waiting = render(<StatusBar snap={snapFor({ spinning: true, idle: false })} />)
    bar = waiting.container.querySelector('.status-bar')!
    expect(bar.firstElementChild?.className).toBe('spinner wait')
    waiting.unmount()

    // a live tool call outranks streaming text, like the TUI's glyph
    const live: LiveTurn = {
      model: 'sonnet',
      thinking: '',
      thinkingOpen: false,
      text: 'partial',
      textOpen: true,
      tools: [{ id: 'c1', name: 'read_file', outputs: [] }],
    }
    const tooling = render(<StatusBar snap={snapFor({ spinning: true })} live={live} />)
    bar = tooling.container.querySelector('.status-bar')!
    expect(bar.firstElementChild?.className).toBe('spinner tool')
  })

  it('rests idle on snapshot facts despite stale live residue', () => {
    // a sealed buffer can still paint; only the snapshot reports activity
    const residue: LiveTurn = {
      model: 'sonnet',
      thinking: 'leftover thinking',
      thinkingOpen: false,
      text: '',
      textOpen: false,
      tools: [],
    }
    const settled = render(
      <StatusBar snap={snapFor({ running: false, spinning: false })} live={residue} />,
    )
    const bar = settled.container.querySelector('.status-bar')!
    expect(bar.firstElementChild?.className).toBe('spinner idle')
  })

  it('colors the context meter at the compact threshold', () => {
    expect(contextLevel(0, 200_000, 150_000)).toBe('')
    expect(contextLevel(100_000, 200_000, 150_000)).toBe('')
    expect(contextLevel(110_000, 200_000, 150_000)).toBe('warn')
    expect(contextLevel(140_000, 200_000, 150_000)).toBe('danger')
  })
})

describe('ToolsPanel disabled states', () => {
  const tool = (over: { name?: string; enabled?: boolean; readOnly?: boolean }) => ({
    name: over.name ?? 'bash',
    source: 'default',
    enabled: over.enabled ?? true,
    readOnly: over.readOnly ?? false,
  })

  it('renders widen-only toggles disabled after the first prompt', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ rows: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const onToast = vi.fn()
    render(
      <ToolsPanel
        sessionId="01S"
        snap={snapFor({
          usage: { turns: 2, total: zero(), child: zero(), estimatedTurns: 0 },
          tools: [tool({ enabled: true }), tool({ name: 'search', enabled: false })],
        })}
        onToast={onToast}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '/tools' }))

    const boxes = screen.getAllByRole('checkbox')
    expect(boxes[0]).toBeDisabled() // disabling an enabled tool is refused upstream
    expect(boxes[1]).not.toBeDisabled() // enabling stays allowed past the first prompt
  })

  it('allows free reshaping before any prompt dispatched', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ rows: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    render(
      <ToolsPanel
        sessionId="01S"
        snap={snapFor({ running: false, tools: [tool({ enabled: true })] })}
        onToast={vi.fn()}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '/tools' }))
    expect(screen.getByRole('checkbox')).not.toBeDisabled()
  })

  it('toggles read-only-classified tools freely at both densities', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(async () => Response.json({ rows: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    for (const density of ['cozy', 'compact'] as const) {
      document.documentElement.dataset.density = density
      const { unmount } = render(
        <ToolsPanel
          sessionId="01S"
          snap={snapFor({ tools: [tool({ name: 'read', readOnly: true })] })}
          onToast={vi.fn()}
        />,
      )
      await user.click(screen.getByRole('button', { name: '/tools' }))
      const box = screen.getByRole('checkbox')
      expect(box).not.toBeDisabled()
      await user.click(box) // disabling rides tools.set's free replacement
      await waitFor(() =>
        expect(fetchSpy).toHaveBeenCalledWith(
          expect.stringContaining('/api/sessions/01S/tools'),
          expect.objectContaining({ method: 'POST' }),
        ),
      )
      unmount()
    }
    document.documentElement.dataset.density = 'cozy'
  })
})
