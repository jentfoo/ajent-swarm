import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QueueDialog } from './QueueDialog'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider, useWorkspace } from '../providers/workspace'

// The follow-up dialog's contract with the wire: submit launches a fresh
// session into the picked directory, then chains it behind the parent with
// the start prompt as the delivered line, re-asking briefly while the fresh
// child is still attaching to the fleet.

const PARENT = '01PARENTSESSION00000A'
const CHILD = '01CHILDSESSION00000B'
const WORKSPACE = '/repo/parent'

// DraftProbe publishes the workspace setter so a test opens the dialog like
// the context menu and settings entry do.
function DraftProbe() {
  const { setQueueDraft } = useWorkspace()
  return <button data-testid="open-draft" onClick={() => setQueueDraft({ parentId: PARENT })} />
}

describe('QueueDialog', () => {
  const bodies: { url: string; method: string; body?: string }[] = []
  let chainFails = 0

  beforeEach(() => {
    bodies.length = 0
    chainFails = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const raw = String(url).replace(/^https?:\/\/[^/]+/, '')
        const path = raw.split('?')[0]
        const method = init?.method ?? 'GET'
        bodies.push({ url: path, method, body: init?.body ? String(init.body) : undefined })
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/saved-sessions') return Response.json([])
        if (path === '/api/models/options') return Response.json([])
        if (path === '/api/attention') return Response.json([])
        if (path === '/api/sessions' && method === 'GET')
          return Response.json([
            { sessionId: PARENT, name: 'left', state: 'online', workspace: WORKSPACE },
          ])
        if (path === '/api/sessions' && method === 'POST')
          return Response.json(
            { sessionId: CHILD, pid: 4242, workspace: WORKSPACE, logPath: '/log' },
            { status: 201 },
          )
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
        if (path === `/api/sessions/${CHILD}/title` && method === 'POST')
          return new Response(null, { status: 204 })
        if (path === `/api/sessions/${CHILD}/stop` && method === 'POST')
          return new Response(null, { status: 204 })
        if (path === `/api/sessions/${PARENT}/chain`) {
          if (chainFails > 0) {
            chainFails--
            return Response.json({ error: 'session_not_found', message: '' }, { status: 404 })
          }
          return Response.json(
            {
              id: 'chn_1',
              parentId: PARENT,
              childId: CHILD,
              childPrompt: 'pick it up',
              state: 'waiting',
              createdAt: 1,
              updatedAt: 1,
            },
            { status: 201 },
          )
        }
        throw new Error(`unexpected fetch ${method} ${path}`)
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
              <QueueDialog />
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  async function open() {
    // every real surface opens the draft from a listed session, so the roster
    // has loaded; wait out the listing before the prefill reads it
    await waitFor(() => {
      expect(bodies.some((b) => b.url === '/api/sessions' && b.method === 'GET')).toBe(true)
    })
    await act(async () => {}) // flush the listing into the swarm provider
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-draft'))
    })
  }

  it('requires the start prompt before any request', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open()

    await user.click(screen.getByRole('button', { name: 'Queue follow up session' }))
    expect(screen.getByText(/start prompt the follow-up session begins with/)).toBeTruthy()
    expect(bodies.filter((b) => b.method === 'POST')).toHaveLength(0)
  })

  it('refuses an ended parent before launching anything', async () => {
    const user = userEvent.setup()
    // the roster lists the parent exited: the dialog still opens on the card
    // (its row keeps its workspace), but submit must launch nothing
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        const method = init?.method ?? 'GET'
        bodies.push({ url: path, method, body: init?.body ? String(init.body) : undefined })
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/saved-sessions') return Response.json([])
        if (path === '/api/models/options') return Response.json([])
        if (path === '/api/attention') return Response.json([])
        if (path === '/api/sessions' && method === 'GET')
          return Response.json([
            { sessionId: PARENT, name: 'left', state: 'exited', workspace: WORKSPACE },
          ])
        throw new Error(`unexpected fetch ${method} ${path}`)
      }),
    )
    renderDialog()
    await open()

    await user.type(screen.getByLabelText(/Session start prompt/), 'pick it up')
    await user.click(screen.getByRole('button', { name: 'Queue follow up session' }))
    expect(screen.getByText(/no longer running, it cannot hand off/)).toBeTruthy()
    expect(bodies.filter((b) => b.method === 'POST')).toHaveLength(0)
  })

  it('launches then chains with the typed prompts', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open()

    await user.type(screen.getByLabelText(/Final prompt for left/), '  wrap it up  ')
    await user.type(screen.getByLabelText(/Session start prompt/), 'pick it up')
    await waitFor(() => {
      expect(document.querySelector('.chain-preview')!.textContent).toContain('pick it up')
    })

    await user.click(screen.getByRole('button', { name: 'Queue follow up session' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    const launch = bodies.find((b) => b.url === '/api/sessions' && b.method === 'POST')
    expect(launch).toBeDefined()
    const launchBody = JSON.parse(launch!.body!)
    expect(launchBody.mode).toBe('new')
    // the follow-up continues in the parent's directory by default
    expect(launchBody.workspace).toBe(WORKSPACE)
    expect(launchBody.model).toBeUndefined()

    const create = bodies.find((b) => b.url.endsWith('/chain'))
    expect(create).toBeDefined()
    const chainBody = JSON.parse(create!.body!)
    expect(chainBody.childId).toBe(CHILD)
    expect(chainBody.finalPrompt).toBe('wrap it up')
    expect(chainBody.childPrompt).toBe('pick it up')
    // launch lands first, the chain create names its session id
    expect(bodies.indexOf(launch!)).toBeLessThan(bodies.indexOf(create!))
  })

  it('names the follow-up before the chain create', async () => {
    const user = userEvent.setup()
    renderDialog()
    await open()

    await user.type(screen.getByLabelText(/Session name/), 'review bot')
    await user.type(screen.getByLabelText(/Session start prompt/), 'pick it up')
    await user.click(screen.getByRole('button', { name: 'Queue follow up session' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })

    const rename = bodies.find((b) => b.url === `/api/sessions/${CHILD}/title`)
    expect(rename).toBeDefined()
    expect(JSON.parse(rename!.body!)).toEqual({ title: 'review bot' })
    const launch = bodies.find((b) => b.url === '/api/sessions' && b.method === 'POST')!
    const create = bodies.find((b) => b.url.endsWith('/chain'))!
    // launch hands back the id, the name lands before the chain create
    expect(bodies.indexOf(launch)).toBeLessThan(bodies.indexOf(rename!))
    expect(bodies.indexOf(rename!)).toBeLessThan(bodies.indexOf(create))
  })

  it('re-asks the chain create while the fresh child attaches', async () => {
    const user = userEvent.setup()
    chainFails = 2
    renderDialog()
    await open()

    await user.type(screen.getByLabelText(/Session start prompt/), 'pick it up')
    await user.click(screen.getByRole('button', { name: 'Queue follow up session' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    const creates = bodies.filter((b) => b.url.endsWith('/chain'))
    expect(creates.length).toBeGreaterThanOrEqual(3)
  })

  it('surfaces a refusal after the retries run out', async () => {
    const user = userEvent.setup()
    chainFails = Number.POSITIVE_INFINITY
    renderDialog()
    await open()

    await user.type(screen.getByLabelText(/Session start prompt/), 'pick it up')
    await user.click(screen.getByRole('button', { name: 'Queue follow up session' }))
    await waitFor(
      () => {
        expect(screen.getByText(/no longer running/)).toBeTruthy()
      },
      { timeout: 4000 },
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    // the refusal reads as an alert, not silent small print
    expect(screen.getByRole('alert')).toHaveTextContent(/no longer running/)
    // the launched child never chains, so the failure path stops it instead
    const stop = bodies.find((b) => b.url === `/api/sessions/${CHILD}/stop`)
    expect(stop).toBeDefined()
    expect(screen.getByText(/The new session was stopped/)).toBeTruthy()
  })
})
