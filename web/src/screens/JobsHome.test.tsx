import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import JobsHome from './JobsHome'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'
import type { Job, Run } from '../api/types'

// The jobs list renders over the real provider stack with fetch and WebSocket
// stubs: rows carry plain-language schedules, the enabled toggle is optimistic,
// manual fires surface their outcome, and empty plus error states read well.
const job: Job = {
  id: 5,
  name: 'nightly sweep',
  workspace: '/repo',
  prompt: 'sweep the logs',
  spawnMode: 'new',
  enabled: true,
  scheduleKind: 'interval',
  intervalSeconds: 1800,
  nextRunAt: '2026-11-06T14:00:00Z',
  onMissed: 'skip',
  overlap: 'run',
  timeoutMinutes: 0,
  keepAlive: false,
  createdAt: '2026-11-01T00:00:00Z',
}

const run: Run = {
  id: 12,
  jobId: 5,
  sessionId: '01RUNSESSION0000',
  prompt: 'sweep the logs',
  trigger: 'schedule',
  status: 'failed',
  startedAt: '2026-11-05T09:00:00Z',
  finishedAt: '2026-11-05T09:02:00Z',
  error: 'submit refused: dialog holds input',
}

// A one-shot source exercises the duplicate path's fire-time clearing.
const onceJob: Job = {
  ...job,
  id: 6,
  name: 'one shot',
  scheduleKind: 'once',
}

let jobsReply: { rows?: Job[]; status?: number }
let jobsFetches = 0
const fireReplies: Array<{ id: number; ok: boolean }> = []
// Update requests park here until a test resolves them, so the optimistic
// window is observable.
let updateBodies: Array<Record<string, unknown>> = []
let updateWaiters: Array<(r: Response) => void> = []
const createBodies: Array<Record<string, unknown>> = []

describe('JobsHome', () => {
  let sockets: MockWebSocket[]

  beforeEach(() => {
    localStorage.clear()
    jobsReply = { rows: [job] }
    jobsFetches = 0
    fireReplies.length = 0
    updateBodies = []
    updateWaiters = []
    createBodies.length = 0
    vi.stubGlobal(
      'WebSocket',
      class extends MockWebSocket {
        constructor(url: string) {
          super(url)
          sockets.push(this)
        }
      },
    )
    sockets = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '')
        const base = path.split('?')[0]
        if (base === '/api/me')
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        if (base === '/api/sessions' || base === '/api/attention' || base === '/api/models') {
          return Promise.resolve(Response.json([]))
        }
        if (base === '/api/jobs/preview') return Promise.resolve(Response.json({ times: [] }))
        if (base === '/api/jobs' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          createBodies.push(body)
          return Promise.resolve(Response.json({ ...body, id: 77 }))
        }
        const listJobs = base === '/api/jobs' && (!init?.method || init.method === 'GET')
        if (listJobs) {
          jobsFetches++
          return Promise.resolve(Response.json(jobsReply.rows ?? []))
        }
        if (base === '/api/runs') {
          const rows = [run, ...fireReplies.map((r) => manualRun(r.id))]
          return Promise.resolve(Response.json(rows))
        }
        const fire = /\/api\/jobs\/(\d+)\/run$/.exec(base)
        if (fire && init?.method === 'POST') {
          const last = fireReplies.at(-1)!
          return last.ok
            ? Promise.resolve(Response.json(manualRun(last.id)))
            : Promise.resolve(
                Response.json(
                  { error: 'conflict', message: 'previous run is still active' },
                  { status: 409 },
                ),
              )
        }
        const update = /\/api\/jobs\/(\d+)$/.exec(base)
        if (update && init?.method === 'PUT') {
          updateBodies.push(JSON.parse(String(init.body)))
          return new Promise<Response>((resolve) => {
            updateWaiters.push(resolve)
          })
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )
  })

  afterEach(() => {
    sockets = []
    vi.unstubAllGlobals()
  })

  function manualRun(id: number): Run {
    return {
      ...run,
      id,
      jobId: 5,
      trigger: 'manual',
      status: 'running',
      startedAt: new Date().toISOString(),
    }
  }

  function renderJobs(initialEntry = '/jobs') {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            <Routes>
              <Route path="/jobs" element={<JobsHome />} />
              <Route path="/jobs/runs" element={<div>runs</div>} />
              <Route path="/jobs/:jobId" element={<JobsHome />} />
              <Route path="*" element={<div>elsewhere</div>} />
            </Routes>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it('renders job rows with schedule, next run and last status', async () => {
    renderJobs()

    expect(await screen.findByText('nightly sweep')).toBeInTheDocument()
    const row = screen.getByTestId('job-5')
    expect(row.textContent).toContain('every 30 minutes')
    expect(row.textContent).toContain('failed') // the latest run's status
    expect(screen.queryByText(/No scheduled jobs yet/)).not.toBeInTheDocument()
  })

  it('shows the empty state', async () => {
    jobsReply = { rows: [] }
    renderJobs()

    expect(await screen.findByText(/No scheduled jobs yet/)).toBeInTheDocument()
  })

  it('surfaces load failures instead of an empty table', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ error: 'internal_error' }, { status: 500 }))),
    )
    renderJobs()

    expect(await screen.findByRole('alert')).toHaveTextContent('internal_error')
  })

  it('toggles enabled optimistically and reverts on refusal', async () => {
    const user = userEvent.setup()
    renderJobs()
    await screen.findByText('nightly sweep')

    // the flip lands while the request is still parked, and the label tracks
    // the direction the click will take
    const box = screen.getByRole('checkbox', { name: 'Disable nightly sweep' })
    expect(box).toBeChecked()
    await user.click(box)
    expect(screen.getByRole('checkbox', { name: 'Enable nightly sweep' })).not.toBeChecked()

    // a refusal puts it back with the backend's complaint alongside
    updateWaiters.shift()!(
      Response.json({ error: 'invalid_request', message: 'workspace missing' }, { status: 400 }),
    )
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Disable nightly sweep' })).toBeChecked()
    })
    expect(await screen.findByText(/workspace missing/)).toBeInTheDocument()

    // an accepted update keeps the flipped state and sent the whole row
    const updated = screen.getByRole('checkbox', { name: 'Disable nightly sweep' })
    await user.click(updated)
    expect(screen.getByRole('checkbox', { name: 'Enable nightly sweep' })).not.toBeChecked()
    updateWaiters.shift()!(Response.json({ ...job, enabled: false }))
    await waitFor(() => {
      expect(updateBodies.at(-1)).toMatchObject({ id: 5, enabled: false })
    })
  })

  it('keeps a toggled row when a poll lands mid request', async () => {
    const user = userEvent.setup()
    renderJobs()
    await screen.findByText('nightly sweep')

    await user.click(screen.getByRole('checkbox', { name: 'Disable nightly sweep' }))
    const box = () => screen.getByRole('checkbox', { name: 'Enable nightly sweep' })
    expect(box()).not.toBeChecked()

    // a poll that read pre-toggle state lands while the PUT is still parked
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(jobsFetches).toBe(2))
    expect(box()).not.toBeChecked()

    // the accepted update re-syncs through its own load, still flipped
    jobsReply = { rows: [{ ...job, enabled: false }] }
    updateWaiters.shift()!(Response.json({ ...job, enabled: false }))
    await waitFor(() => expect(jobsFetches).toBe(3))
    expect(box()).not.toBeChecked()
  })

  it('keeps overlapping toggles consistent through their requests', async () => {
    const user = userEvent.setup()
    renderJobs()
    await screen.findByText('nightly sweep')

    const box = screen.getByRole('checkbox', { name: 'Disable nightly sweep' })
    await user.click(box)
    await user.click(screen.getByRole('checkbox', { name: 'Enable nightly sweep' }))
    expect(box).toBeChecked()
    expect(updateBodies).toHaveLength(2)

    // both requests accept and both re-syncs confirm the double flip
    jobsReply = { rows: [job] }
    updateWaiters.shift()!(Response.json({ ...job, enabled: false }))
    updateWaiters.shift()!(Response.json(job))
    await waitFor(() => expect(jobsFetches).toBe(3))
    expect(screen.getByRole('checkbox', { name: 'Disable nightly sweep' })).toBeChecked()
  })

  it('renders rows with the earliest next run first', async () => {
    const late = { ...job, id: 9, name: 'late job', nextRunAt: '2026-11-06T18:00:00Z' }
    const early = { ...job, id: 2, name: 'early job', nextRunAt: '2026-11-06T10:00:00Z' }
    jobsReply = { rows: [late, early] } // the payload keeps its insertion order
    renderJobs()

    await screen.findByText('early job')
    const ids = screen.getAllByTestId(/^job-\d+$/).map((row) => row.getAttribute('data-testid'))
    expect(ids).toEqual(['job-2', 'job-9'])
  })

  it('fires manually and reports the outcome', async () => {
    const user = userEvent.setup()
    renderJobs()
    await screen.findByText('nightly sweep')

    fireReplies.push({ id: 20, ok: true })
    await user.click(screen.getByRole('button', { name: 'Run nightly sweep now' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Run #20 started.')

    fireReplies.push({ id: 21, ok: false })
    await user.click(screen.getByRole('button', { name: 'Run nightly sweep now' }))
    expect(await screen.findByText(/previous run is still active/)).toBeInTheDocument()
  })

  it('qualifies the run button with its job name', async () => {
    const other = { ...job, id: 7, name: 'weekly digest' }
    jobsReply = { rows: [job, other] }
    renderJobs()

    await screen.findByText('nightly sweep')
    expect(screen.getByRole('button', { name: 'Run nightly sweep now' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run weekly digest now' })).toBeInTheDocument()
  })

  it('opens the editor for a stored job and closes back to the list', async () => {
    renderJobs('/jobs/5')
    await screen.findByText('Edit “nightly sweep”')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Scheduled jobs')).toBeInTheDocument()
  })

  it('creates from /jobs/new through the same route tree', async () => {
    renderJobs('/jobs/new')
    expect(await screen.findByText('New job')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Scheduled jobs')).toBeInTheDocument()
  })

  it('duplicates a row into a seeded create', async () => {
    const user = userEvent.setup()
    renderJobs()
    await screen.findByText('nightly sweep')

    await user.click(screen.getByRole('button', { name: 'Duplicate nightly sweep' }))
    expect(await screen.findByText('New job')).toBeInTheDocument()

    // the source's facts ride along verbatim, with the seeded adjustments on top
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Copy of nightly sweep')
    expect(screen.getByLabelText(/Workspace directory/)).toHaveValue('/repo')
    expect(screen.getByRole('spinbutton', { name: 'Every' })).toHaveValue(30)
    expect(screen.getByLabelText('Unit')).toHaveValue('minutes')
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('sweep the logs')
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked()

    // saving rides the create path: a POST whose body carries no id
    await user.click(screen.getByRole('button', { name: 'Create job' }))
    await waitFor(() => expect(createBodies).toHaveLength(1))
    expect(createBodies[0].id).toBeUndefined()
    expect(createBodies[0]).toMatchObject({
      name: 'Copy of nightly sweep',
      enabled: false,
      scheduleKind: 'interval',
      intervalSeconds: 1800,
    })
  })

  it('duplicates a one shot with an empty fire time', async () => {
    jobsReply = { rows: [onceJob] }
    const user = userEvent.setup()
    renderJobs()
    await screen.findByText('one shot')

    await user.click(screen.getByRole('button', { name: 'Duplicate one shot' }))
    expect(await screen.findByText('New job')).toBeInTheDocument()

    // the stored slot is usually past, so validation demands a fresh pick
    const fireAt = screen.getByLabelText(/Fire at/)
    expect(fireAt).toHaveValue('')
    expect(screen.getByText('Pick the fire time.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create job' })).toBeDisabled()

    // picking a slot clears the error and unblocks the save
    fireEvent.change(fireAt, { target: { value: '2026-12-01T09:30' } })
    expect(screen.queryByText('Pick the fire time.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create job' })).toBeEnabled()
  })

  it('opens a plain create when the duplicate source is gone', async () => {
    renderJobs('/jobs/new?from=999')

    expect(await screen.findByText('New job')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('')
  })
})
