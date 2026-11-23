import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChainDialog } from './ChainDialog'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider, useWorkspace } from '../providers/workspace'

// The dialog's contract with the wire: the preview names the parent and the
// future answer placeholder, an empty child prompt resolves to the visible default
// continuation line, and the confirm mints the pendingId the child's
// eventual submit resolves by.

const PARENT = '01PARENTSESSION00000A'
const CHILD = '01CHILDSESSION00000B'

// DraftProbe publishes the workspace setter so a test opens the dialog like
// the drop handlers do.
function DraftProbe() {
  const { setChainDraft } = useWorkspace()
  return (
    <button
      data-testid="open-draft"
      onClick={() => setChainDraft({ parentId: PARENT, childId: CHILD })}
    />
  )
}

describe('ChainDialog', () => {
  const bodies: { url: string; body?: string }[] = []
  // create calls fail while the counter holds, then succeed, so a refusal can
  // exercise the error surface without breaking the other cases
  let chainFails = 0

  beforeEach(() => {
    bodies.length = 0
    chainFails = 0
    const names: { sessionId: string; name?: string }[] = [
      { sessionId: PARENT, name: 'left' },
      { sessionId: CHILD, name: 'right' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const raw = String(url).replace(/^https?:\/\/[^/]+/, '')
        const path = raw.split('?')[0]
        bodies.push({ url: path, body: init?.body ? String(init.body) : undefined })
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions')
          return Response.json(
            names.map((n) => ({ sessionId: n.sessionId, name: n.name, state: 'online' })),
          )
        if (path === '/api/attention') return Response.json([])
        if (path === `/api/sessions/${PARENT}/entries`) {
          const entry = {
            id: '01A',
            type: 'message',
            data: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', data: { text: 'old answer' } }],
              },
            },
          }
          return Response.json({ entries: [entry] })
        }
        if (path === `/api/sessions/${PARENT}/chain`) {
          if (chainFails > 0) {
            chainFails--
            return Response.json({ error: 'chain_conflict', message: 'gone' }, { status: 409 })
          }
          return Response.json(
            {
              id: 'chn_1',
              parentId: PARENT,
              childId: CHILD,
              childPrompt: 'continue',
              state: 'waiting',
              createdAt: 1,
              updatedAt: 1,
            },
            { status: 201 },
          )
        }
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderDialog() {
    render(
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              <DraftProbe />
              <ChainDialog />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  async function open() {
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-draft'))
    })
  }

  it('previews the header line with the future answer', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open()

    await user.type(screen.getByPlaceholderText(/one last thing/), 'summarize')
    const preview = document.querySelector('.chain-preview')!
    expect(preview.textContent).toContain('Prior session last message:')
    expect(preview.textContent).toContain('the final prompt’s answer rides here once it finishes')
    expect(preview.textContent).not.toContain('old answer')
    expect(preview.textContent).toContain('----')
  })

  it('sends the default continuation line on confirm', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open()

    // an empty child prompt still confirms: the default line rides the
    // preview and the submit verbatim, never a silent substitution
    const confirm = screen.getByRole('button', { name: 'Chain sessions' })
    expect(confirm.hasAttribute('disabled')).toBe(false)
    await waitFor(() => {
      // the parent is literally named left, so the line reads where left
      // left off: the default names whatever the namer resolved
      expect(document.querySelector('.chain-preview')!.textContent).toContain(
        'Continue from where left left off.',
      )
    })

    await user.click(confirm)

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    const create = bodies.find((b) => b.url.endsWith('/chain'))
    expect(create).toBeDefined()
    const body = JSON.parse(create!.body!)
    expect(body.childId).toBe(CHILD)
    expect(body.childPrompt).toBe('Continue from where left left off.')
    // no pending id rides the create, the server mints the restart-recovery
    // correlation itself
    expect(body.pendingId).toBeUndefined()

    // a typed prompt wins over the default
    bodies.length = 0
    await open()
    await user.type(screen.getByLabelText(/Prompt for right/), 'pick this up')
    await user.click(screen.getByRole('button', { name: 'Chain sessions' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    const typed = JSON.parse(bodies.find((b) => b.url.endsWith('/chain'))!.body!)
    expect(typed.childPrompt).toBe('pick this up')
  })

  it('rides the dirty guard on a close with edits', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open()
    await user.type(screen.getByLabelText(/Prompt for right/), 'draft text')

    fireEvent.keyDown(window, { key: 'Escape' })
    // the guarded close asks first, discarding confirms the teardown
    expect(screen.getByText(/Discard unsaved changes?/i)).toBeTruthy()
    const discard = screen.getAllByRole('button').find((b) => b.textContent === 'Discard')
    await user.click(discard!)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('surfaces a refused create as an alert', async () => {
    const user = userEvent.setup()
    chainFails = 1
    renderDialog()
    await open()

    await user.click(screen.getByRole('button', { name: 'Chain sessions' }))

    // the dialog stays open and the refusal reads as an alert
    expect(await screen.findByRole('alert')).toHaveTextContent('gone')
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    // a retry succeeds once the refusal clears
    await user.click(screen.getByRole('button', { name: 'Chain sessions' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })
})
