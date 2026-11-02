import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JobEditor } from './JobEditor'
import type { Job } from '../api/types'

// The editor is provider-free: it talks to /api/jobs/preview for its schedule
// preview and workspace check, then to the jobs CRUD on save. Stubbed fetch
// scripts those; the debounce settles against real timers.
const storedJob: Job = {
  id: 3,
  name: 'nightly',
  workspace: '/repo',
  commandPrefix: '',
  prompt: 'sweep logs',
  spawnMode: 'new',
  enabled: true,
  scheduleKind: 'daily',
  dailyTime: '09:00',
  tz: 'UTC',
  nextRunAt: null,
  onMissed: 'skip',
  overlap: 'run',
  timeoutMinutes: 0,
  keepAlive: false,
  createdAt: '2026-11-01T00:00:00Z',
}

type PreviewReply = { times?: string[]; workspaceError?: string } | { code: number }

let previewReply: PreviewReply
const previewBodies: unknown[] = []
const savedRoutes: Array<{ path: string; body: unknown }> = []

describe('JobEditor', () => {
  beforeEach(() => {
    previewReply = { times: [] }
    previewBodies.length = 0
    savedRoutes.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url)
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
        if (path === '/api/jobs/preview') {
          previewBodies.push(JSON.parse(String(init?.body)))
          if ('code' in previewReply) {
            return Promise.resolve(
              Response.json(
                { error: 'invalid_request', message: 'daily time must be HH:MM' },
                { status: previewReply.code },
              ),
            )
          }
          return Promise.resolve(Response.json(previewReply))
        }
        if (path === '/api/jobs' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          savedRoutes.push({ path, body })
          return Promise.resolve(Response.json({ ...body, id: 9 }))
        }
        const put = /\/api\/jobs\/(\d+)$/.exec(path)
        if (put && init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          savedRoutes.push({ path, body })
          return Promise.resolve(Response.json({ ...body, id: Number(put[1]) }))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderEditor(props: Partial<Parameters<typeof JobEditor>[0]> = {}) {
    return render(
      <JobEditor
        workspaces={['/repo', '/other']}
        models={['model-a']}
        onSaved={props.onSaved ?? (() => {})}
        onCancel={props.onCancel ?? (() => {})}
        {...props}
      />,
    )
  }

  async function settlePreview() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450)) // outlast the 350ms debounce
    })
  }

  it('previews the next three fire times from the backend', async () => {
    previewReply = {
      times: ['2026-11-06T14:00:00Z', '2026-11-07T14:00:00Z', '2026-11-08T14:00:00Z'],
    }
    renderEditor()
    await settlePreview()

    expect(screen.getByTestId('schedule-preview').getElementsByTagName('li').length).toBe(3)
    // the draft's schedule rode to the backend verbatim
    expect(previewBodies[0]).toMatchObject({
      scheduleKind: 'interval',
      intervalSeconds: 1800,
      count: 3,
    })
  })

  it('surfaces a workspace check from the backend next to the field', async () => {
    previewReply = { times: [], workspaceError: 'workspace /nope: stat failed' }
    renderEditor({ job: storedJob })
    await settlePreview()

    expect(screen.getByText(/stat failed/)).toBeInTheDocument()
  })

  it('shows scheduling refusals from the backend', async () => {
    previewReply = { code: 400 }
    renderEditor({ job: storedJob })
    await settlePreview()

    // the backend's own message lands in the preview slot; the draft itself is valid
    expect(screen.getByText('daily time must be HH:MM')).toBeInTheDocument()
  })

  it('blocks saving until client-side validation passes, then saves', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    renderEditor({ onSaved })

    await user.click(screen.getByRole('button', { name: 'Create job' }))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByText('Name is required.')).toBeInTheDocument()
    expect(savedRoutes.length).toBe(0)

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'nightly')
    // the workspace input carries a datalist, so label queries stay role-free
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    await user.click(screen.getByRole('button', { name: 'Create job' }))

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 9, name: 'nightly' })),
    )
    expect(savedRoutes[0]).toMatchObject({ path: '/api/jobs' })
  })

  it('warns about command prefix injection only when set', async () => {
    const user = userEvent.setup()
    renderEditor()

    expect(screen.queryByText(/Injection risk/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/Command prefix/), 'docker run -i img')
    expect(screen.getByText(/Injection risk/)).toBeInTheDocument()
  })

  it('edits an existing job and anchors previews at its stored creation', async () => {
    const onSaved = vi.fn()
    previewReply = { times: ['2026-11-07T09:00:00Z'] }
    renderEditor({ job: storedJob, onSaved })
    await settlePreview()

    expect(previewBodies[0]).toMatchObject({
      createdAt: storedJob.createdAt,
      name: 'nightly',
      dailyTime: '09:00',
    })

    const user = userEvent.setup()
    await user.clear(screen.getByRole('textbox', { name: /^Name/ }))
    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'renamed')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 3, name: 'renamed' })),
    )
  })
})
