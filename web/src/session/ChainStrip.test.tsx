import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainStrip } from './ChainStrip'
import type { AttentionRow, Chain } from '../api/types'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider, useWorkspace } from '../providers/workspace'

// The strip's contract: each link cancels through its own chain id, edit
// prefills the record the workspace fetched, and a fresh failure renders its
// cause without live affordances. A session chained in both directions keeps
// both links addressable.

const PARENT = '01PARENTSESSION00000A'
const MIDDLE = '01MIDDLESESSION00000M'
const CHILD = '01CHILDSESSION00000B'

function row(over: Partial<AttentionRow>): AttentionRow {
  return {
    sessionId: MIDDLE,
    kind: 'awaiting',
    ...over,
  } as AttentionRow
}

const inboundChain: Chain = {
  id: 'chn_in',
  parentId: PARENT,
  childId: MIDDLE,
  childPrompt: 'continue',
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1,
}

const outboundChain: Chain = {
  id: 'chn_out',
  parentId: MIDDLE,
  childId: CHILD,
  childPrompt: 'carry on',
  state: 'final',
  createdAt: 2,
  updatedAt: 2,
}

describe('ChainStrip', () => {
  const deletes: string[] = []
  let attention: AttentionRow[] = []
  let chains: Chain[] = []

  beforeEach(() => {
    deletes.length = 0
    attention = []
    chains = [inboundChain, outboundChain]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const raw = String(url).replace(/^https?:\/\/[^/]+/, '')
        const path = raw.split('?')[0]
        if (init?.method === 'DELETE') {
          deletes.push(path)
          return new Response(null, { status: 204 })
        }
        const chain = chains.find((ch) => `/api/chains/${ch.id}` === path)
        if (init?.method === 'GET' && chain !== undefined) return Response.json(chain)
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions')
          return Response.json([
            { sessionId: PARENT, name: 'left', state: 'online' },
            { sessionId: MIDDLE, name: 'middle', state: 'online' },
            { sessionId: CHILD, name: 'right', state: 'online' },
          ])
        if (path === '/api/attention') return Response.json(attention)
        if (path === '/api/chains') return Response.json(chains)
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // DraftProbe publishes the workspace draft so a test reads what edit opened
  function DraftProbe() {
    const { chainDraft } = useWorkspace()
    return (
      <div data-testid="draft">
        {chainDraft === null ? 'none' : (chainDraft.chain?.id ?? 'new')}
      </div>
    )
  }

  async function mount() {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <ChainStrip sessionId={MIDDLE} />
              <DraftProbe />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await act(async () => {})
  }

  it('renders nothing without chain facts', async () => {
    attention = [row({})]
    await mount()
    expect(screen.queryByLabelText('Session chains')).toBeNull()
  })

  it('renders both links and cancels each through its own id', async () => {
    attention = [
      row({
        chainedOn: PARENT,
        chainedOnId: 'chn_in',
        deliveringTo: CHILD,
        deliveringId: 'chn_out',
      }),
    ]
    await mount()

    const strip = screen.getByLabelText('Session chains')
    expect(strip.textContent).toContain('waiting on left')
    expect(strip.textContent).toContain('hands off into right')

    const cancels = screen.getAllByTitle('Cancel this chain and the links stacked behind it')
    expect(cancels).toHaveLength(2)
    const user = userEvent.setup()
    await user.click(cancels[0])
    await user.click(cancels[0]) // the first press arms, the second confirms
    await waitFor(() => expect(deletes).toEqual(['/api/chains/chn_in']))
    await user.click(screen.getAllByTitle('Cancel this chain and the links stacked behind it')[1])
    await user.click(screen.getAllByTitle('Cancel this chain and the links stacked behind it')[1])
    await waitFor(() => expect(deletes).toEqual(['/api/chains/chn_in', '/api/chains/chn_out']))
  })

  it('prefills edit from the fetched record, only while editable', async () => {
    attention = [row({ chainedOn: PARENT, chainedOnId: 'chn_in' })]
    await mount()

    const edit = await screen.findByTitle("Edit this chain's prompts")
    const user = userEvent.setup()
    await user.click(edit)
    await waitFor(() => expect(screen.getByTestId('draft').textContent).toBe('chn_in'))
  })

  it('hides edit once the record is past its edit point', async () => {
    chains = [{ ...inboundChain, state: 'delivering' }]
    attention = [row({ chainedOn: PARENT, chainedOnId: 'chn_in' })]
    await mount()

    expect(screen.queryByTitle("Edit this chain's prompts")).toBeNull()
    // cancel stays: every live state accepts it
    expect(screen.getByTitle('Cancel this chain and the links stacked behind it')).toBeDefined()
  })

  it('renders a fresh failure without live affordances', async () => {
    chains = [{ ...inboundChain, state: 'failed', reason: 'parent exited' }]
    attention = [
      row({
        chainedOn: PARENT,
        chainedOnId: 'chn_in',
        chainFailure: 'parent exited',
      }),
    ]
    await mount()

    const strip = await screen.findByLabelText('Session chains')
    expect(strip.textContent).toContain('chain failed: parent exited')
    expect(strip.textContent).toContain('failed')
    expect(screen.queryByTitle('Cancel this chain')).toBeNull()
    expect(screen.queryByTitle("Edit this chain's prompts")).toBeNull()
  })
})
