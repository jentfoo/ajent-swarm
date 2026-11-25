import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentSettingsMenu } from './AgentSettingsMenu'
import { GlobalSettingsMenu } from '../shell/GlobalSettingsMenu'
import { ChainDialog } from '../workspace/ChainDialog'
import { QueueDialog } from '../workspace/QueueDialog'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// Both hamburger menus ride one shared dialog shell: opening renders the body as a
// centered modal over a backdrop, and backdrop click or Escape closes it.
// The agent menu's chain entry swaps the modal into a target picker, and
// picking a session hands the draft to the shared chain dialog.

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const path = String(url).split('?')[0]
      for (const [suffix, body] of Object.entries(routes)) {
        if (path.endsWith(suffix)) return Response.json(body)
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    }),
  )
}

function tree(children: React.ReactNode) {
  return (
    <MemoryRouter>
      <AuthProvider>
        <SwarmProvider>
          <WorkspaceProvider>{children}</WorkspaceProvider>
        </SwarmProvider>
      </AuthProvider>
    </MemoryRouter>
  )
}

describe('AgentSettingsMenu', () => {
  it('opens the settings dialog inside a backdrop', async () => {
    stubFetch({
      '/api/me': { username: 'you', via: 'cookie' },
      '/api/sessions': [],
      '/api/attention': [],
      '/settings': { rows: [] },
    })
    render(tree(<AgentSettingsMenu sessionId="01S" />))

    const trigger = screen.getByRole('button', { name: 'Agent settings' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await userEvent.setup().click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const dialog = screen.getByRole('dialog', { name: 'Agent settings' })
    expect(document.querySelector('.modal-backdrop')).toContainElement(dialog)
  })

  it('closes on backdrop click and escape but not inner clicks', async () => {
    stubFetch({
      '/api/me': { username: 'you', via: 'cookie' },
      '/api/sessions': [],
      '/api/attention': [],
      '/settings': { rows: [] },
    })
    const user = userEvent.setup()
    render(tree(<AgentSettingsMenu sessionId="01S" />))

    await user.click(screen.getByRole('button', { name: 'Agent settings' }))
    // clicks inside the dialog leave it open
    fireEvent.click(screen.getByRole('dialog', { name: 'Agent settings' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Agent settings' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    await user.click(screen.getByRole('button', { name: 'Agent settings' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders global settings through the same shell', async () => {
    stubFetch({
      '/api/me': { username: 'you', via: 'cookie' },
      '/api/sessions': [],
      '/api/attention': [],
      '/api/settings': { titleModel: '' },
      '/api/models/options': [],
    })
    render(tree(<GlobalSettingsMenu />))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Global settings' }))
    expect(
      document.querySelector('.modal-backdrop')!.querySelector('.card.modal.settings-modal'),
    ).toContainElement(screen.getByRole('dialog', { name: 'Global settings' }))
    expect(await screen.findByLabelText('Session titling model')).toBeInTheDocument()

    fireEvent.click(document.querySelector('.modal-backdrop')!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('chains through the menu picker into the shared dialog', async () => {
    stubFetch({
      '/api/me': { username: 'you', via: 'cookie' },
      '/api/sessions': [
        { sessionId: '01SOURCE000000000A', name: 'source', state: 'online' },
        { sessionId: '01TARGET0000000000B', name: 'target', state: 'online' },
      ],
      '/api/attention': [],
      '/settings': { rows: [] },
      '/entries': { entries: [] },
    })
    const user = userEvent.setup()
    render(
      tree(
        <>
          <AgentSettingsMenu sessionId="01SOURCE000000000A" />
          <ChainDialog />
        </>,
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Agent settings' }))
    await user.click(screen.getByRole('button', { name: 'Chain after this session…' }))

    // the picker lists every other live session, never the parent itself
    const targets = screen.getAllByRole('listitem')
    expect(targets).toHaveLength(1)
    expect(targets[0]).toHaveTextContent('target')

    // each row keeps a native button, the wrapper carries only the list item
    await user.click(within(targets[0]).getByRole('button'))
    const dialog = await screen.findByRole('dialog', { name: 'Chain target after source' })
    expect(dialog).toBeInTheDocument()
    expect(screen.queryByText('Pick the session that runs after this one:')).not.toBeInTheDocument()
  })

  it('queues a follow-up through its own menu entry', async () => {
    stubFetch({
      '/api/me': { username: 'you', via: 'cookie' },
      '/api/sessions': [{ sessionId: '01SOURCE000000000A', name: 'source', state: 'online' }],
      '/api/attention': [],
      '/api/saved-sessions': [],
      '/api/models/options': [],
      '/settings': { rows: [] },
    })
    const user = userEvent.setup()
    render(
      tree(
        <>
          <AgentSettingsMenu sessionId="01SOURCE000000000A" />
          <QueueDialog />
        </>,
      ),
    )

    await user.click(screen.getByRole('button', { name: 'Agent settings' }))
    await user.click(screen.getByRole('button', { name: 'Queue follow up session…' }))

    const dialog = await screen.findByRole('dialog', {
      name: 'Queue follow up session after source',
    })
    expect(dialog).toBeInTheDocument()
  })

  it('stands down queue and chain once the session ends', async () => {
    stubFetch({
      '/api/me': { username: 'you', via: 'cookie' },
      '/api/sessions': [{ sessionId: '01SOURCE000000000A', name: 'source', state: 'exited' }],
      '/api/attention': [],
      '/settings': { rows: [] },
    })
    render(tree(<AgentSettingsMenu sessionId="01SOURCE000000000A" />))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Agent settings' }))
    const dialog = screen.getByRole('dialog', { name: 'Agent settings' })

    // nothing runs to hand off from, so both entries leave the menu
    await vi.waitFor(() => {
      expect(within(dialog).queryByRole('button', { name: 'Queue follow up session…' })).toBeNull()
      expect(within(dialog).queryByRole('button', { name: 'Chain after this session…' })).toBeNull()
    })
  })
})
