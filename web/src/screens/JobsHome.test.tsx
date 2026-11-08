import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import JobsHome from './JobsHome'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'
import { mobileLayout } from '../hooks/useMediaQuery'
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

// A queued row exercises the badge and the idle label beside its wait.
const queuedJob: Job = {
  ...job,
  id: 7,
  name: 'later',
  queued: true,
  scheduleKind: 'once',
  nextRunAt: '2026-11-05T21:00:00Z',
  keepAlive: true,
  runWhenIdle: true,
}

// A one-shot source exercises the duplicate path's fire-time clearing.
const onceJob: Job = {
  ...job,
  id: 6,
  name: 'one shot',
  scheduleKind: 'once',
}

let jobsReply: { rows?: Job[]; status?: number }
let runsReply: Run[] | undefined
let jobsFetches = 0
const fireReplies: Array<{ id: number; ok: boolean }> = []
// Update requests park here until a test resolves them, so the optimistic
// window is observable.
let updateBodies: Array<Record<string, unknown>> = []
let updateWaiters: Array<(r: Response) => void> = []
const createBodies: Array<Record<string, unknown>> = []
const queueBodies: Array<Record<string, unknown>> = []

describe('JobsHome', () => {
  let sockets: MockWebSocket[]

  beforeEach(() => {
    localStorage.clear()
    jobsReply = { rows: [job] }
    runsReply = undefined
    jobsFetches = 0
    fireReplies.length = 0
    updateBodies = []
    updateWaiters = []
    createBodies.length = 0
    queueBodies.length = 0
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
        if (
          base === '/api/sessions' ||
          base === '/api/attention' ||
          base === '/api/models/options'
        ) {
          return Promise.resolve(Response.json([]))
        }
        // the job forms load tool options beside the models listing
        if (base === '/api/tools/options') return Promise.resolve(Response.json([]))
        if (base === '/api/jobs/preview') return Promise.resolve(Response.json({ times: [] }))
        if (base === '/api/jobs' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          createBodies.push(body)
          return Promise.resolve(Response.json({ ...body, id: 77 }))
        }
        if (base === '/api/jobs/queue' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          queueBodies.push(body)
          return Promise.resolve(Response.json({ ...body, id: 78, queued: true }))
        }
        const listJobs = base === '/api/jobs' && (!init?.method || init.method === 'GET')
        if (listJobs) {
          jobsFetches++
          return Promise.resolve(Response.json(jobsReply.rows ?? []))
        }
        if (base === '/api/runs') {
          const rows = runsReply ?? [run, ...fireReplies.map((r) => manualRun(r.id))]
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

  function renderJobs(initialEntry = '/jobs', nav?: ReactElement) {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            {nav}
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

  // stubPhoneLayout reports only the shared 48rem breakpoint as matching, so
  // JobsHome mounts its card presentation; everything else stays desktop.
  function stubPhoneLayout(): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === mobileLayout,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }))
  }

  // NavButton drives MemoryRouter between routes directly, standing in for the
  // URL edits and back-forward navigation that reuse one JobsHome instance.
  function NavButton({ to, children }: { to: string; children: string }): ReactElement {
    const navigate = useNavigate()
    return (
      <button type="button" onClick={() => navigate(to)}>
        {children}
      </button>
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

  it('keeps the desktop table above the phone breakpoint', async () => {
    renderJobs()

    expect(await screen.findByTestId('job-5')).toHaveProperty('tagName', 'TR')
    expect(document.querySelector('.jobs-table')).not.toBeNull()
    expect(document.querySelector('.job-card')).toBeNull()
  })

  it('renders each job as one card with every action on phones', async () => {
    stubPhoneLayout()
    jobsReply = { rows: [job, queuedJob] }
    renderJobs()

    const card = await screen.findByTestId('job-5')
    expect(card).toHaveClass('job-card')
    expect(card.textContent).toContain('every 30 minutes') // schedule summary
    expect(screen.getByText('failed')).toBeInTheDocument() // status beside the label
    expect(document.querySelector('.jobs-table')).toBeNull()

    // the excerpts keep their tooltips, like the table cells they stand in for
    expect(card.querySelector('.run-prompt-cell')).toHaveAttribute('title', 'sweep the logs')
    expect(card.querySelector('.run-error-excerpt')).toHaveAttribute(
      'title',
      'submit refused: dialog holds input',
    )

    // every action is reachable from the card, including an explicit Edit that
    // replaces tapping the row's name link
    expect(screen.getByRole('checkbox', { name: 'Disable nightly sweep' })).toBeChecked()
    expect(screen.getByRole('link', { name: 'Copy nightly sweep' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run nightly sweep now' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('link', { name: 'Edit nightly sweep' }))
    expect(await screen.findByText('Edit “nightly sweep”')).toBeInTheDocument()
  })

  it('badges queued jobs on phone cards with their idle wait', async () => {
    stubPhoneLayout()
    jobsReply = { rows: [job, queuedJob] }
    renderJobs()

    const card = await screen.findByTestId('job-7')
    expect(card.textContent).toContain('queued')
    expect(card.textContent).toContain('when idle')
    expect(card.textContent).not.toContain('once at') // no schedule summary
  })

  it('carries full text in tooltips where rows truncate', async () => {
    const prompt =
      'sweep every log under /var/log, drop the rotated ones, and summarize the outliers for the nightly report'
    jobsReply = { rows: [{ ...job, prompt }] }
    renderJobs()

    const row = await screen.findByTestId('job-5')
    // the slice stays, the tooltip carries what the clipped cell hides
    const promptCell = row.querySelector('.run-prompt-cell')
    expect(promptCell).toHaveAttribute('title', prompt)
    expect(promptCell).toHaveTextContent(prompt.slice(0, 80))
    expect(row.querySelector('.run-error-excerpt')).toHaveAttribute(
      'title',
      'submit refused: dialog holds input',
    )
  })

  it('badges each job with its newest run in the window', async () => {
    // the shared run is the 09:00 failure; a later success must win the badge
    const older: Run = { ...run, id: 11 }
    const newer: Run = {
      ...run,
      status: 'ok',
      startedAt: '2026-11-05T10:00:00Z',
      finishedAt: '2026-11-05T10:05:00Z',
      error: undefined,
    }
    runsReply = [newer, older] // newest first, both inside the window
    renderJobs()

    const row = await screen.findByTestId('job-5')
    expect(row.textContent).toContain('ok')
    expect(row.textContent).not.toContain('failed')
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

  it('shields card toggles from poll overwrites on phones', async () => {
    stubPhoneLayout()
    const user = userEvent.setup()
    renderJobs()
    await screen.findByTestId('job-5')

    await user.click(screen.getByRole('checkbox', { name: 'Disable nightly sweep' }))
    const box = () => screen.getByRole('checkbox', { name: 'Enable nightly sweep' })
    expect(box()).not.toBeChecked()

    // the same poll shield holds in the card layout, which renders from the
    // one shared toggle path
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => expect(jobsFetches).toBe(2))
    expect(box()).not.toBeChecked()

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

  it('wears the button styling on header links directly', async () => {
    renderJobs()

    // no Link-wrapped buttons: one tab stop and one accessible name per control
    expect(await screen.findByRole('link', { name: 'Queue' })).toHaveClass('btn')
    expect(screen.getByRole('link', { name: 'New job' })).toHaveClass('btn', 'primary')
  })

  it('queues a prompt from the header action', async () => {
    const user = userEvent.setup()
    renderJobs()
    await screen.findByText('nightly sweep')

    await user.click(screen.getByRole('link', { name: 'Queue' }))
    expect(await screen.findByRole('dialog', { name: 'Queue a prompt' })).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'later')
    await user.type(screen.getByLabelText(/Workspace directory/), '/repo')
    await user.type(screen.getByRole('textbox', { name: /^Prompt/ }), 'review the diff')
    await user.click(screen.getByRole('button', { name: 'Queue prompt' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Queued “later”.')
    expect(queueBodies).toHaveLength(1)
    expect(queueBodies[0]).toMatchObject({
      name: 'later',
      workspace: '/repo',
      prompt: 'review the diff',
    })
    // the composer closes a fetch tick after the status lands, so wait it out
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Queue a prompt' })).toBeNull())
  })

  it('marks queued rows with a badge and the idle wait', async () => {
    jobsReply = { rows: [job, queuedJob] }
    renderJobs()

    const row = await screen.findByTestId('job-7')
    expect(row.textContent).toContain('queued')
    expect(row.textContent).toContain('when idle')
    expect(row.textContent).not.toContain('once at') // no schedule summary

    // the waiting row sorts first: its slot is the oldest one due
    const ids = screen.getAllByTestId(/^job-\d+$/).map((r) => r.getAttribute('data-testid'))
    expect(ids).toEqual(['job-7', 'job-5'])
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

    await user.click(screen.getByRole('link', { name: 'Copy nightly sweep' }))
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

    await user.click(screen.getByRole('link', { name: 'Copy one shot' }))
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

  it('resets the editor when the route swaps jobs', async () => {
    const user = userEvent.setup()
    const digest = { ...job, id: 7, name: 'weekly digest', prompt: 'digest the week' }
    jobsReply = { rows: [job, digest] }
    renderJobs('/jobs/5', <NavButton to="/jobs/7">go digest</NavButton>)

    expect(await screen.findByText('Edit “nightly sweep”')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('nightly sweep')
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('sweep the logs')

    // the swap remounts the editor on job 7's values, so a save writes those
    await user.click(screen.getByRole('button', { name: 'go digest' }))
    expect(await screen.findByText('Edit “weekly digest”')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('weekly digest')
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('digest the week')

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateBodies).toHaveLength(1))
    expect(updateBodies[0]).toMatchObject({ id: 7, name: 'weekly digest' })

    // the accepted save closes back to the list under the new job's name
    await act(async () => {
      updateWaiters.shift()!(Response.json(digest))
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Job “weekly digest” saved.')
  })

  it('reseeds a duplicate create when the from job changes', async () => {
    const user = userEvent.setup()
    const digest = { ...job, id: 7, name: 'weekly digest' }
    jobsReply = { rows: [job, digest] }
    renderJobs('/jobs/new?from=5', <NavButton to="/jobs/new?from=7">from digest</NavButton>)

    expect(await screen.findByText('New job')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Copy of nightly sweep')

    // the create rides the from param's identity, so the swap reseeds the form
    await user.click(screen.getByRole('button', { name: 'from digest' }))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('Copy of weekly digest'),
    )
  })
})
