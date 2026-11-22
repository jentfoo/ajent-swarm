import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionContextMenu, useSessionMenu } from './SessionContextMenu'
import { QueueDialog } from '../workspace/QueueDialog'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// The right-click menu's contract: opening pins the menu to the pointer and
// its queue entry lands the follow-up draft on the shared queue dialog while
// the session runs, standing down once it ends. Held touches open the same
// menu through a press point, and the optional rename and chain entries
// report back for surfaces without inline controls.

const SESSION = '01TARGETSESSION0000C'

// MenuProbe carries a session row whose context menu a test opens like a
// right-click on a tab, rail row or card does.
function MenuProbe({ onChain }: { onChain?: () => void }) {
  const { menu, openSessionMenu, closeSessionMenu } = useSessionMenu()
  return (
    <>
      <div data-testid="row" onContextMenu={(ev) => openSessionMenu(ev, SESSION)} />
      <SessionContextMenu menu={menu} onClose={closeSessionMenu} onChain={onChain} />
    </>
  )
}

// HoldProbe opens the same menu at a bare press point, the way a held touch
// does, carrying the optional rename entry.
function HoldProbe({ onRename }: { onRename: () => void }) {
  const { menu, openSessionMenuAt, closeSessionMenu } = useSessionMenu()
  return (
    <>
      <div data-testid="row" onPointerDown={() => openSessionMenuAt(30, 40, SESSION)} />
      <SessionContextMenu menu={menu} onClose={closeSessionMenu} onRename={onRename} />
    </>
  )
}

describe('SessionContextMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).split('?')[0]
        const method = init?.method ?? 'GET'
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions' && method === 'GET')
          return Response.json([{ sessionId: SESSION, name: 'target', state: 'online' }])
        if (path === `/api/sessions/${SESSION}/stop` && method === 'POST')
          return new Response(null, { status: 204 })
        if (path === '/api/attention') return Response.json([])
        if (path === '/api/saved-sessions') return Response.json([])
        if (path === '/api/models/options') return Response.json([])
        throw new Error(`unexpected fetch ${method} ${path}`)
      }),
    )
  }

  it('queues a follow-up through the pointer menu', async () => {
    stubFetch()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <MenuProbe />
              <QueueDialog />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 30, clientY: 40 })

    const item = screen.getByRole('menuitem', { name: 'Queue follow up session…' })
    await user.click(item)

    // the entry lands the queue draft, the shared dialog takes over
    const dialog = await screen.findByRole('dialog', {
      name: 'Queue follow up session after target',
    })
    expect(dialog).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on an outside press without opening the draft', async () => {
    stubFetch()
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <MenuProbe />
              <QueueDialog />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 30, clientY: 40 })
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stops through the armed two-step entry', async () => {
    const stops: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).split('?')[0]
        const method = init?.method ?? 'GET'
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions' && method === 'GET')
          return Response.json([{ sessionId: SESSION, name: 'target', state: 'online' }])
        if (path === `/api/sessions/${SESSION}/stop` && method === 'POST') {
          stops.push(path)
          return new Response(null, { status: 204 })
        }
        return Response.json([])
      }),
    )
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <MenuProbe />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 30, clientY: 40 })

    // the first click only arms, no request yet
    await user.click(screen.getByRole('menuitem', { name: 'Stop session' }))
    expect(stops).toHaveLength(0)
    expect(screen.getByRole('menuitem', { name: 'Stop?' })).toBeInTheDocument()

    // the second click confirms: the endpoint fires, the menu closes
    await user.click(screen.getByRole('menuitem', { name: 'Stop?' }))
    await waitFor(() => {
      expect(stops).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })

  it('offers chain after through the menu while running', async () => {
    stubFetch()
    const onChain = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <MenuProbe onChain={onChain} />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 30, clientY: 40 })

    await user.click(screen.getByRole('menuitem', { name: 'Chain after…' }))

    // the entry reports back and the menu closes behind it
    expect(onChain).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('hides queue, chain and stop for an ended session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions')
          return Response.json([{ sessionId: SESSION, name: 'target', state: 'exited' }])
        return Response.json([])
      }),
    )
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <MenuProbe onChain={vi.fn()} />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 30, clientY: 40 })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Queue follow up session…' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Chain after…' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Stop session' })).toBeNull()
  })

  it('opens at a bare press point and reports the rename entry', async () => {
    stubFetch()
    const onRename = vi.fn()
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <HoldProbe onRename={onRename} />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.pointerDown(screen.getByTestId('row'))
    await user.click(screen.getByRole('menuitem', { name: 'Rename…' }))

    // the entry reports back and the menu closes behind it
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
