import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JobEditor } from './JobEditor'
import { defaultDraft } from './jobDraft'
import type { Job } from '../api/types'

// The editor is provider-free: it talks to /api/jobs/preview for its schedule
// preview and workspace check, then to the jobs CRUD on save. Tool options
// arrive as a prop (EditorWithFacts loads them from /api/tools/options), but
// the endpoint stays stubbed so the strict fetch default never trips.
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
        if (path === '/api/tools/options') {
          return Promise.resolve(
            Response.json([
              { name: 'builtin:read', source: 'built-in' },
              { name: 'builtin:web_search', source: 'built-in' },
              { name: 'repo_search', source: 'mcp:repo' },
            ]),
          )
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
    const toolOptions: Parameters<typeof JobEditor>[0]['toolOptions'] = [
      { name: 'builtin:read', source: 'built-in', enabled: false, readOnly: false },
      { name: 'builtin:web_search', source: 'built-in', enabled: true, readOnly: false },
      { name: 'repo_search', source: 'mcp:repo', enabled: true, readOnly: false },
    ]
    return render(
      <JobEditor
        workspaces={['/repo', '/other']}
        models={['model-a']}
        toolOptions={props.toolOptions ?? toolOptions}
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

  it('offers no command prefix field; legacy values ride along untouched', () => {
    renderEditor({ job: { ...storedJob, commandPrefix: 'timeout 300' } })

    expect(screen.queryByLabelText(/Command prefix/)).not.toBeInTheDocument()
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

  it('sends weekday selections and run-when-idle options', async () => {
    const user = userEvent.setup()
    renderEditor()

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'weekly')
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    // mondays and fridays only; the picker rides every recurring kind,
    // interval included, for an always-on job that rests on weekends
    await user.click(screen.getByRole('checkbox', { name: /Mon/ }))
    await user.click(screen.getByRole('checkbox', { name: /Fri/ }))
    // run when idle with a one-hour cap
    await user.click(
      screen.getByRole('checkbox', { name: /Only start when no session has worked/ }),
    )
    await user.selectOptions(screen.getByLabelText(/If still busy, skip after waiting/), '3600')

    await user.click(screen.getByRole('button', { name: 'Create job' }))
    await waitFor(() => expect(savedRoutes).toHaveLength(1))
    expect(savedRoutes[0].body).toMatchObject({
      scheduleKind: 'interval',
      weekdays: 'mon,fri',
      runWhenIdle: true,
    })
  })

  it('reveals the trigger command gate and its outcome picker together', async () => {
    const user = userEvent.setup()
    renderEditor()

    expect(screen.queryByLabelText(/Run the job when the command/)).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/Pre-run command/), 'git pull --ff-only')
    const picker = screen.getByLabelText(/Run the job when the command/)
    expect(picker).toBeInTheDocument()
    await user.selectOptions(picker, 'error')

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'gated')
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    await user.click(screen.getByRole('button', { name: 'Create job' }))
    await waitFor(() => expect(savedRoutes).toHaveLength(1))
    expect(savedRoutes[0].body).toMatchObject({
      triggerCommand: 'git pull --ff-only',
      triggerOn: 'error',
    })
  })

  it('keeps a stored weekday set checked when editing', async () => {
    renderEditor({ job: { ...storedJob, weekdays: 'tue,thu' } })
    await settlePreview()

    expect(screen.getByRole('checkbox', { name: /Tue/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Thu/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Mon/ })).not.toBeChecked()
  })

  it('reopens a sub-minute interval in seconds and saves it unchanged', async () => {
    const onSaved = vi.fn()
    renderEditor({
      job: { ...storedJob, scheduleKind: 'interval', intervalSeconds: 30 },
      onSaved,
    })
    await settlePreview()

    expect(screen.getByRole('spinbutton', { name: 'Every' })).toHaveValue(30)
    expect(screen.getByLabelText('Unit')).toHaveValue('seconds')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 3 })))
    expect(savedRoutes[0].body).toMatchObject({ scheduleKind: 'interval', intervalSeconds: 30 })
  })

  it('renders a seed draft as the initial create state', async () => {
    previewReply = { times: ['2026-11-10T08:30:00Z'] }
    renderEditor({
      seed: {
        ...defaultDraft(),
        name: 'Copy of nightly',
        workspace: '/other',
        scheduleKind: 'daily',
        dailyTime: '08:30',
        tz: 'UTC',
        enabled: false,
      },
    })

    // create mode throughout: no editing target, so no delete button
    expect(screen.getByRole('heading', { name: 'New job' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create job' })).toBeInTheDocument()
    expect(screen.queryByText('Delete…')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Copy of nightly')
    expect(screen.getByLabelText(/Workspace directory/)).toHaveValue('/other')
    expect(screen.getByLabelText(/At \(HH:MM\)/)).toHaveValue('08:30')
    expect(screen.getByLabelText(/Timezone/)).toHaveValue('UTC')
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked()

    // the seeded draft drives the preview like a typed one
    await settlePreview()
    expect(previewBodies[0]).toMatchObject({ name: 'Copy of nightly', dailyTime: '08:30' })
  })

  it('fills the timezone datalist without rebuilding it per keystroke', () => {
    renderEditor({ job: storedJob })

    const options = document.querySelectorAll('#job-timezones option')
    expect(options.length).toBeGreaterThan(0)
    expect(screen.getByLabelText(/Timezone/)).toHaveValue('UTC')
  })

  it('keeps a stored custom set checked when editing', () => {
    renderEditor({
      job: { ...storedJob, toolsCustom: true, tools: 'builtin:web_search,repo_search' },
    })

    expect(screen.getByRole('checkbox', { name: 'Custom tool set' })).toBeChecked()
    // every option lists, with the stored selection checked and others not
    expect(screen.getByRole('checkbox', { name: /builtin:read/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /builtin:web_search/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /repo_search/ })).toBeChecked()
  })

  it('hides the tool rows until the master checkbox turns on', () => {
    renderEditor({ job: storedJob })

    expect(screen.getByRole('checkbox', { name: 'Custom tool set' })).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: /builtin:read/ })).not.toBeInTheDocument()
  })

  it('says so when no live session could be read but keeps the stored list', () => {
    renderEditor({
      job: { ...storedJob, toolsCustom: true, tools: 'legacy_tool' },
      toolOptions: [],
    })

    expect(screen.getByText(/No live session to read tool names from/)).toBeInTheDocument()
    // the saved name still renders as a row, so the set stays editable
    expect(screen.getByRole('checkbox', { name: /legacy_tool/ })).toBeChecked()
  })

  it('saves the joined custom list with its flag', async () => {
    const user = userEvent.setup()
    renderEditor()

    await user.click(screen.getByRole('checkbox', { name: 'Custom tool set' }))
    await user.click(screen.getByRole('checkbox', { name: /builtin:web_search/ }))
    await user.click(screen.getByRole('checkbox', { name: /repo_search/ }))
    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'tooled')
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    await user.click(screen.getByRole('button', { name: 'Create job' }))

    await waitFor(() => expect(savedRoutes).toHaveLength(1))
    expect(savedRoutes[0].body).toMatchObject({
      toolsCustom: true,
      tools: 'builtin:web_search,repo_search',
    })
  })
})
