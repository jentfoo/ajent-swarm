import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StatusBar } from './StatusBar'
import { ToolsPanel } from './ToolsPanel'
import type { CtlState } from '../api/types'
import type { LiveTurn } from '../state/eventApplier'

// The status bar renders the streamed segments plus context, queue and
// activity; model and permission mode live in the header, so neither appears
// here. The meter fills against the compaction budget with a `~`-marked count,
// plain activity rows lead newest first under one overflow marker, and the
// tooltips carry the fuller context and usage breakdowns. The tools panel
// offers every registered tool as a toggle — readOnly is permission metadata,
// not a lock — with widen-only state after the first prompt rendered as
// disabled instead of a silent refusal.

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
    // both label lengths render; CSS picks one by bar width
    expect(screen.getByText('1.2k tok')).toBeInTheDocument()
    expect(screen.queryByText(/path/)).not.toBeInTheDocument() // empty removed
    expect(screen.queryByText('auto+write')).not.toBeInTheDocument() // header owns mode
    expect(screen.queryByText('auto+w')).not.toBeInTheDocument() // no short shadow either
    expect(screen.getByText('2 queued')).toBeInTheDocument()
    expect(screen.getByText('reading files')).toBeInTheDocument()
    // sub-agent jobs land as a tally instead of vanishing into the activity mix
    expect(screen.getByText('agents 1 active')).toBeInTheDocument()
  })

  it('tallies sub-agents as active, total and done', () => {
    render(
      <StatusBar
        snap={snapFor({
          activity: [
            { key: 'sub-1', text: 'sub-1 reading files', rank: 0 },
            { key: 'sub-2', text: 'sub-2 scanning tests', rank: 1 },
            { key: 'sub-3', text: 'sub-3 drafting report', rank: 2 },
          ],
          status: {
            segments: [
              {
                key: 'subagents',
                text: 'subagents: 2 running (oldest 30s), 1 queued, 4 done',
                short: 'sub 3',
                order: 40,
              },
            ],
          },
        })}
      />,
    )
    expect(screen.getByText('agents 3 active · 7 total · 4 done')).toBeInTheDocument()
    // the short form never renders beside the tally
    expect(screen.queryByText('sub 3')).not.toBeInTheDocument()
  })

  it('reports a finished batch from the segment alone', () => {
    render(
      <StatusBar
        snap={snapFor({
          status: { segments: [{ key: 'subagents', text: 'subagents: 6 done', order: 40 }] },
        })}
      />,
    )
    expect(screen.getByText('agents 6 total · 6 done')).toBeInTheDocument()
  })

  it('reads structured counts ahead of the prose', () => {
    // a wording drift may scramble the sentence; the counts are the contract
    render(
      <StatusBar
        snap={snapFor({
          status: {
            segments: [
              {
                key: 'subagents',
                text: 'subagents: unreadable prose',
                order: 40,
                counts: { running: 2, queued: 1, done: 4 },
              },
            ],
          },
        })}
      />,
    )
    expect(screen.getByText('agents 3 active · 7 total · 4 done')).toBeInTheDocument()
  })

  it('falls back to live rows without an upstream segment', () => {
    render(
      <StatusBar
        snap={snapFor({ activity: [{ key: 'sub-2', text: 'sub-2 reading files', rank: 0 }] })}
      />,
    )
    expect(screen.getByText('agents 1 active')).toBeInTheDocument()
  })

  it('keeps upstream wording when its tally drifts', () => {
    render(
      <StatusBar
        snap={snapFor({
          status: { segments: [{ key: 'subagents', text: 'subagents: unclear', order: 40 }] },
        })}
      />,
    )
    expect(screen.getByText('subagents: unclear')).toBeInTheDocument()
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

  it('renders the context meter against the compaction budget', () => {
    const view = render(
      <StatusBar
        snap={snapFor({
          context: {
            used: 75_000,
            window: 200_000,
            reserve: 10_000,
            compact: 150_000,
            estimated: false,
          },
        })}
      />,
    )
    // fill and label measure 75k against the 150k compaction budget
    expect(view.container.querySelector('.meter-fill')).toHaveStyle({ width: '50%' })
    expect(screen.getByLabelText('Context 50% full')).toBeInTheDocument()
    expect(screen.getByText('75k/200k')).toBeInTheDocument()
    expect(screen.getByLabelText('Context 50% full')).toHaveAttribute(
      'title',
      'context 75,000/200,000 tokens, compacts at 150,000',
    )
  })

  it('marks the context count estimated and fills to the window', () => {
    const view = render(
      <StatusBar
        snap={snapFor({
          context: { used: 180_000, window: 200_000, reserve: 0, compact: 0, estimated: true },
        })}
      />,
    )
    // no compaction budget: the raw window denominates, danger past 90%
    expect(view.container.querySelector('.meter')!.className).toBe('meter danger')
    expect(screen.getByText('~180k/200k')).toBeInTheDocument()
    expect(screen.getByLabelText('Context 90% full')).toHaveAttribute(
      'title',
      'context ~180,000/200,000 tokens',
    )
  })

  it('joins parallel activity rows newest first', () => {
    render(
      <StatusBar
        snap={snapFor({
          activity: [
            { key: 'call-1', text: 'read app.ts · 12 kb', rank: 5 },
            { key: 'call-2', text: 'write notes.go · 4 kb', rank: 5 },
          ],
        })}
      />,
    )
    expect(screen.getByText('write notes.go · 4 kb · read app.ts · 12 kb')).toBeInTheDocument()
  })

  it('caps plain activity rows with an overflow line', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      key: `call-${i + 1}`,
      text: `work ${i + 1}`,
      rank: 5,
    }))
    render(<StatusBar snap={snapFor({ activity: rows })} />)
    // newest four listed, the oldest two under the overflow marker
    expect(screen.getByText('work 6 · work 5 · work 4 · work 3')).toBeInTheDocument()
    expect(screen.getByText('+2 more')).toBeInTheDocument()
  })

  it('details the usage breakdown in the turns tooltip', () => {
    render(
      <StatusBar
        snap={snapFor({
          usage: {
            turns: 4,
            total: {
              input: 12_000,
              output: 5_000,
              cacheRead: 8_000,
              cacheWrite: 0,
              reasoning: 900,
            },
            child: { input: 4_000, output: 2_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            estimatedTurns: 0,
          },
        })}
      />,
    )
    expect(screen.getByText('4 turns')).toHaveAttribute(
      'title',
      '12,000 in / 5,000 out\ncache 8,000 read / 0 write\n900 reasoning\nsub-agents 4,000 in / 2,000 out',
    )
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

  it('toggles read-only-classified tools freely', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn(async () => Response.json({ rows: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    render(
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
  })
})
