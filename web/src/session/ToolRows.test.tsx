import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ToolRows } from './ToolRows'
import type { CtlState, ToolState } from '../api/types'

// The shared tool rows both surfaces render: one checkbox row per streamed
// tool with its source, toggled through the composed intent machine, and
// widen-only locks rendered disabled with their reason where the surface
// explains it.

function toolRows(): ToolState[] {
  return [
    { name: 'read_file', source: 'built-in', enabled: false, readOnly: false },
    { name: 'write_file', source: 'built-in', enabled: false, readOnly: false },
  ]
}

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
}

function snapFor(tools: ToolState[], overrides: Record<string, unknown> = {}): CtlState {
  return {
    session: { id: '01S' },
    workspace: '/w',
    cwd: '/w',
    head: '',
    model: {
      key: 'anthropic/claude-sonnet',
      short: 'sonnet',
      window: 200_000,
      caps: { reasoning: false, images: false, parallelToolCalls: false },
    },
    permission: '',
    tools,
    usage: { turns: 0, total: emptyUsage, child: emptyUsage },
    context: { used: 0, window: 200_000, reserve: 0, compact: 0, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    seat: { held: false, yours: false },
    ...overrides,
  } as CtlState
}

function stubFetch(reply: Record<string, unknown>) {
  const spy = vi.fn(async (_url: string | URL, _init?: RequestInit) => Response.json(reply))
  vi.stubGlobal('fetch', spy)
  return spy
}

function sentNames(spy: ReturnType<typeof stubFetch>): string[][] {
  return spy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).names)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// a checkbox row's accessible name spans its label text, so queries go by
// position like the surface suites do
function renderRows(snap: CtlState, lockTooltips = false) {
  const onToast = vi.fn()
  const rows = (next: CtlState, tooltips: boolean) => (
    <div className="tool-rows">
      <ToolRows sessionId="01S" snap={next} onToast={onToast} lockTooltips={tooltips} />
    </div>
  )
  const view = render(rows(snap, lockTooltips))
  return {
    onToast,
    rerenderWith: (next: CtlState, tooltips = lockTooltips) => view.rerender(rows(next, tooltips)),
  }
}

describe('ToolRows', () => {
  it('renders one row per tool with its name and source', () => {
    renderRows(snapFor(toolRows()))

    const rows = screen.getAllByRole('checkbox')
    expect(rows).toHaveLength(2)
    expect(screen.getByText('read_file')).toBeInTheDocument()
    expect(screen.getByText('write_file')).toBeInTheDocument()
    expect(screen.getAllByText('built-in')).toHaveLength(2)
  })

  it('composes quick toggles into one complete set each', async () => {
    const spy = stubFetch({ rows: [] })
    renderRows(snapFor(toolRows()))
    const user = userEvent.setup()
    const boxes = screen.getAllByRole('checkbox')

    await user.click(boxes[0])
    await user.click(boxes[1])

    // the second post carries the first even though no stream rows landed in
    // between, deriving from stale rows would silently undo it
    await vi.waitFor(() => expect(sentNames(spy)).toHaveLength(2))
    expect(sentNames(spy)[0]).toEqual(['read_file'])
    expect(sentNames(spy)[1]).toEqual(['read_file', 'write_file'])
  })

  it('renders streamed facts without posting', () => {
    const spy = stubFetch({ rows: [] })
    renderRows(snapFor([{ name: 'bash', source: 'default', enabled: true, readOnly: false }]))

    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(spy).not.toHaveBeenCalled()
  })

  it('locks disabling toggles once widen-only', () => {
    renderRows(
      snapFor(
        [
          { name: 'bash', source: 'default', enabled: true, readOnly: false },
          { name: 'search', source: 'default', enabled: false, readOnly: false },
        ],
        { usage: { turns: 2, total: emptyUsage, child: emptyUsage } },
      ),
    )

    // disabling an enabled tool is refused upstream, enabling stays allowed
    const bash = screen.getAllByRole('checkbox')[0]
    expect(bash).toBeDisabled()
    expect(bash.closest('.tool-row')).toHaveClass('disabled')
    expect(screen.getAllByRole('checkbox')[1]).not.toBeDisabled()
  })

  it('names locked checkboxes only for hover surfaces', () => {
    const snap = snapFor([{ name: 'bash', source: 'default', enabled: true, readOnly: false }], {
      usage: { turns: 2, total: emptyUsage, child: emptyUsage },
    })
    const { rerenderWith } = renderRows(snap)
    // touch explains the rule once in its own hint paragraph instead
    expect(screen.getByRole('checkbox')).not.toHaveAttribute('title')

    rerenderWith(snap, true) // hover surfaces carry it per checkbox
    expect(screen.getByRole('checkbox')).toHaveAttribute(
      'title',
      'Widen-only after the first prompt: this toggle can only enable',
    )
  })
})
