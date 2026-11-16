import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceProvider, useWorkspace } from './workspace'
import { AuthProvider } from './auth'
import { SwarmProvider } from './swarm'
import type { AttentionRow } from '../api/types'

// The acknowledgment wiring at the wire boundary: a dialog acknowledgment
// names the digest row that actually holds the dialog being settled, so twin
// instances of one session settle their own rows everywhere.

function digestRow(overrides: Partial<AttentionRow> & { sessionId: string }): AttentionRow {
  return {
    openInteractions: 0,
    running: false,
    idle: true,
    kind: 'awaiting',
    ...overrides,
  }
}

// AckProbe hands the provider's dialog acknowledgment over, so tests post one
// like an answered dialog does without mounting a session surface.
let ackDialog: (sessionId: string, dialogId: number) => void = () => {
  throw new Error('provider not mounted')
}

function AckProbe() {
  const { acknowledgeDialog } = useWorkspace()
  useEffect(() => {
    ackDialog = acknowledgeDialog
  }, [acknowledgeDialog])
  return null
}

// postLikeDialog answers one dialog the way SessionView and its mobile twin do.
async function postLikeDialog(sessionId: string, dialogId: number) {
  await act(async () => {
    ackDialog(sessionId, dialogId)
  })
}

describe('WorkspaceProvider acknowledgments', () => {
  let attention: AttentionRow[]
  const ackBodies: string[] = []

  beforeEach(() => {
    ackBodies.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions') return Response.json([])
        if (path === '/api/attention') return Response.json(attention)
        if (path === '/api/attention/ack') {
          ackBodies.push(String(init?.body))
          return new Response(null, { status: 204 })
        }
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function renderProvider() {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <AckProbe />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    await act(async () => {}) // settle the mount fetches, the digest is in
  }

  it('settles the twin instance holding the dialog', async () => {
    attention = [
      digestRow({
        sessionId: 'twin',
        pid: 101,
        openInteractions: 1,
        kind: 'needs-input',
        reason: 'allow write?',
        dialogId: 3,
      }),
      digestRow({
        sessionId: 'twin',
        pid: 202,
        openInteractions: 1,
        kind: 'needs-input',
        reason: 'deploy now?',
        dialogId: 7,
      }),
    ]
    await renderProvider()

    // answering either twin names its own row, never whichever digest row
    // comes first
    await postLikeDialog('twin', 7)
    await postLikeDialog('twin', 3)
    await vi.waitFor(() => {
      expect(ackBodies).toEqual([
        '{"sessionId":"twin","pid":202,"dialogId":7}',
        '{"sessionId":"twin","pid":101,"dialogId":3}',
      ])
    })
  })

  it('stands in the first row while the digest lags', async () => {
    attention = [
      digestRow({ sessionId: 'twin', pid: 101 }),
      digestRow({
        sessionId: 'twin',
        pid: 202,
        running: true,
        idle: false,
        kind: 'working',
        reason: 'reading main.go',
      }),
    ]
    await renderProvider()

    // no row names this dialog yet, the session's first row keeps today's
    // single-instance behavior instead of posting nothing at all
    await postLikeDialog('twin', 9)
    await vi.waitFor(() => {
      expect(ackBodies).toEqual(['{"sessionId":"twin","pid":101,"dialogId":9}'])
    })
  })

  it('posts without a pid once no digest row remains', async () => {
    attention = []
    await renderProvider()

    // a session that ended between answer and refresh still acknowledges, the
    // ledger keeps it and nothing re-raises later
    await postLikeDialog('ended', 5)
    await vi.waitFor(() => {
      expect(ackBodies).toEqual(['{"sessionId":"ended","dialogId":5}'])
    })
  })
})
