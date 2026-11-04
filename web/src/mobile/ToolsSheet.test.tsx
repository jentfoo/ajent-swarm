import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ToolsSheet } from './ToolsSheet'
import type { CtlState, ToolState } from '../api/types'

// The panel toggles optimistically: every flip sends the complete desired set
// derived from pending intent instead of stream rows that lag a round trip,
// refusals snap their row back, and stream rows reconcile confirmed changes.

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

function stubFetch(respond: (url: string) => Response) {
  const spy = vi.fn(async (url: string | URL, _init?: RequestInit) =>
    respond(String(url).replace(/^https?:\/\/[^/]+/, '')),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

function sentNames(spy: ReturnType<typeof stubFetch>): string[][] {
  return spy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).names)
}

describe('ToolsSheet', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderSheet(snap: CtlState, sessionId = '01S') {
    const onToast = vi.fn()
    const view = render(
      <ToolsSheet sessionId={sessionId} snap={snap} open onClose={() => {}} onToast={onToast} />,
    )
    return {
      onToast,
      rerenderWith: (next: CtlState, nextId = sessionId) =>
        view.rerender(
          <ToolsSheet sessionId={nextId} snap={next} open onClose={() => {}} onToast={onToast} />,
        ),
    }
  }

  it('applies quick successive toggles as one composed set', async () => {
    const spy = stubFetch((url) => {
      if (url === '/api/sessions/01S/tools') return Response.json({ rows: toolRows() })
      throw new Error(`unexpected fetch ${url}`)
    })

    renderSheet(snapFor(toolRows()))
    const user = userEvent.setup()
    const boxes = screen.getAllByRole('checkbox')

    await user.click(boxes[0])
    await user.click(boxes[1])

    // the second toggle must carry the first one even though no stream rows
    // landed in between; deriving from stale rows would silently undo it
    await vi.waitFor(() => expect(sentNames(spy)).toHaveLength(2))
    expect(sentNames(spy)[0]).toEqual(['read_file'])
    expect(sentNames(spy)[1]).toEqual(['read_file', 'write_file'])
  })

  it('reconciles a confirmed toggle against stream rows', async () => {
    stubFetch((url) => {
      if (url === '/api/sessions/01S/tools') return Response.json({ rows: toolRows() })
      throw new Error(`unexpected fetch ${url}`)
    })

    const enabled = [{ name: 'read_file', source: 'built-in', enabled: true, readOnly: false }]
    const { rerenderWith } = renderSheet(snapFor(toolRows()))
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked()

    // the tools event confirms; intent clears and only stream rows decide
    rerenderWith(snapFor(enabled))
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked()
    rerenderWith(snapFor(toolRows())) // an external change lands afterwards
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked()
  })

  it('snaps a refused toggle back', async () => {
    const spy = stubFetch((url) => {
      if (url === '/api/sessions/01S/tools') {
        return Response.json(
          { error: 'unavailable', message: 'a turn owns the loop' },
          { status: 409 },
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })

    const { onToast } = renderSheet(snapFor(toolRows()))
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('checkbox')[0])

    await vi.waitFor(() => expect(sentNames(spy)).toHaveLength(1))
    expect(onToast).toHaveBeenCalledWith('unavailable: a turn owns the loop', 'error')
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked()
  })

  it('clears pending toggles when the session changes', async () => {
    stubFetch((url) => {
      if (url === '/api/sessions/01S/tools') return Response.json({ rows: toolRows() })
      throw new Error(`unexpected fetch ${url}`)
    })

    const { rerenderWith } = renderSheet(snapFor(toolRows()))
    const user = userEvent.setup()
    await user.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked()

    rerenderWith(snapFor(toolRows()), '02S')
    expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked()
  })
})
