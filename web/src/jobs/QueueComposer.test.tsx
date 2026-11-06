import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { QueueComposer } from './QueueComposer'
import type { Job } from '../api/types'

// The composer is provider-free: it only talks to POST /api/jobs/queue. The
// launch facts arrive as props (QueueWithFacts loads them), so their endpoints
// stay stubbed and the strict fetch default never trips.
const queuedReply: Job = {
  id: 11,
  name: 'someday',
  workspace: '/repo',
  prompt: 'review the diff',
  spawnMode: 'new',
  enabled: true,
  queued: true,
  scheduleKind: 'once',
  nextRunAt: '2026-11-05T23:00:00Z',
  onMissed: 'skip',
  overlap: 'run',
  keepAlive: true,
  runWhenIdle: true,
  createdAt: '2026-11-05T22:00:00Z',
}

const queueBodies: Array<Record<string, unknown>> = []
let queueStatus = 201

describe('QueueComposer', () => {
  beforeEach(() => {
    queueBodies.length = 0
    queueStatus = 201
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (path === '/api/jobs/queue' && init?.method === 'POST') {
          queueBodies.push(JSON.parse(String(init.body)))
          if (queueStatus !== 201) {
            return Promise.resolve(
              Response.json(
                { error: 'invalid_request', message: 'name is required' },
                { status: queueStatus },
              ),
            )
          }
          return Promise.resolve(Response.json(queuedReply))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderComposer() {
    return render(
      <QueueComposer
        workspaces={['/repo', '/other']}
        models={['model-a']}
        toolOptions={[
          { name: 'builtin:read', source: 'built-in', enabled: false, readOnly: false },
          { name: 'repo_search', source: 'mcp:repo', enabled: true, readOnly: false },
        ]}
        onQueued={() => {}}
        onCancel={() => {}}
      />,
    )
  }

  it('requires a prompt beside the shared facts before submitting', async () => {
    const user = userEvent.setup()
    renderComposer()

    expect(screen.getByText('Prompt is required.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeDisabled()

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'someday')
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeDisabled() // prompt still empty

    await user.type(screen.getByRole('textbox', { name: /^Prompt/ }), 'review the diff')
    expect(screen.getByRole('button', { name: 'Queue prompt' })).toBeEnabled()
  })

  it('sends only the fields the queue endpoint accepts', async () => {
    const user = userEvent.setup()
    const onQueued = vi.fn()
    render(
      <QueueComposer
        workspaces={[]}
        models={['model-a']}
        toolOptions={[]}
        onQueued={onQueued}
        onCancel={() => {}}
      />,
    )

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'someday')
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    await user.type(screen.getByRole('textbox', { name: /^Prompt/ }), 'review the diff')
    await user.type(screen.getByLabelText(/^Model/), 'model-a')
    await user.click(screen.getByRole('button', { name: 'Queue prompt' }))

    await waitFor(() => expect(onQueued).toHaveBeenCalledWith(queuedReply))
    expect(queueBodies).toHaveLength(1)
    expect(queueBodies[0]).toEqual({
      name: 'someday',
      workspace: '/repo',
      prompt: 'review the diff',
      model: 'model-a',
      permission: '',
      toolsCustom: false,
      tools: '',
      triggerCommand: '',
      triggerOn: 'success',
    })
  })

  it('carries the custom tool set and pre-run command through', async () => {
    const user = userEvent.setup()
    renderComposer()

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'someday')
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    await user.type(screen.getByRole('textbox', { name: /^Prompt/ }), 'review the diff')
    await user.click(screen.getByRole('checkbox', { name: 'Custom tool set' }))
    await user.click(screen.getByRole('checkbox', { name: /builtin:read/ }))
    await user.type(screen.getByLabelText(/Pre-run command/), 'git pull --ff-only')
    await user.selectOptions(screen.getByLabelText(/Run the job when the command/), 'error')

    await user.click(screen.getByRole('button', { name: 'Queue prompt' }))
    await waitFor(() => expect(queueBodies).toHaveLength(1))
    expect(queueBodies[0]).toMatchObject({
      toolsCustom: true,
      tools: 'builtin:read',
      triggerCommand: 'git pull --ff-only',
      triggerOn: 'error',
    })
  })

  it('surfaces a refused queue and stays open', async () => {
    queueStatus = 400
    const user = userEvent.setup()
    const onQueued = vi.fn()
    render(
      <QueueComposer
        workspaces={[]}
        models={[]}
        toolOptions={[]}
        onQueued={onQueued}
        onCancel={() => {}}
      />,
    )

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'someday')
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    await user.type(screen.getByRole('textbox', { name: /^Prompt/ }), 'review the diff')
    await user.click(screen.getByRole('button', { name: 'Queue prompt' }))

    expect(await screen.findByText(/name is required/)).toBeInTheDocument()
    expect(onQueued).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Queue a prompt' })).toBeInTheDocument()
  })

  it('states the fixed policy as text instead of controls', () => {
    renderComposer()

    expect(screen.getByText(/no session has been active for 10 minutes/)).toBeInTheDocument()
    expect(screen.getByText(/session stays open afterwards/)).toBeInTheDocument()
    // nothing the queue pins may pose as an editable control here
    expect(screen.queryByRole('checkbox', { name: 'Run when idle' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', { name: /Keep the session running/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Session start/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Fire at/)).not.toBeInTheDocument()
  })
})
