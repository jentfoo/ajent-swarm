import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import RunsHistory from './RunsHistory'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { MockWebSocket } from '../test/mockWebSocket'
import { formatTimestamp, relativeTimestamp } from '../jobs/schedule'
import type { Job, Run } from '../api/types'

// Run history renders over the real provider stack: rows join job names,
// filters narrow through the backend's ?job= and client-side status, a
// run's detail routes to its session view when live or its recorded
// transcript when not, an open detail tracks each poll instead of a frozen
// snapshot, and only the newest load may commit over an in-flight one.
function jobRow(id: number, name: string): Job {
  return {
    id,
    name,
    workspace: `/repo-${id}`,
    spawnMode: 'new',
    enabled: true,
    scheduleKind: 'interval',
    intervalSeconds: 3600,
    nextRunAt: null,
    onMissed: 'skip',
    overlap: 'run',
    timeoutMinutes: 0,
    keepAlive: false,
    createdAt: '2026-11-01T00:00:00Z',
  }
}

const jobs = [jobRow(5, 'nightly'), jobRow(6, 'weekly')]

const runs: Run[] = [
  {
    id: 11,
    jobId: 5,
    sessionId: '01LIVE0000000000',
    prompt: 'sweep now',
    trigger: 'schedule',
    status: 'ok',
    startedAt: '2026-11-05T09:00:00Z',
    finishedAt: '2026-11-05T09:02:00Z',
  },
  {
    id: 12,
    jobId: 6,
    sessionId: '01OFFLINE00000000',
    prompt: 'weekly thing',
    trigger: 'manual',
    status: 'failed',
    startedAt: '2026-11-04T09:00:00Z',
    finishedAt: '2026-11-04T09:05:00Z',
    error: 'submit refused: dialog holds input',
  },
  {
    id: 13,
    jobId: 5,
    trigger: 'schedule',
    status: 'skipped',
    startedAt: '2026-11-03T09:00:00Z',
    finishedAt: '2026-11-03T09:00:01Z',
    error: 'skipped: previous run is still active',
  },
]

const savedPage = {
  sessionId: '01OFFLINE00000000',
  head: 'e2',
  entries: [
    {
      id: 'e1',
      type: 'message',
      ts: 1730000000000,
      data: {
        message: { role: 'user', content: [{ type: 'text', data: { text: 'run the sweep' } }] },
      },
    },
    {
      id: 'e2',
      type: 'message',
      ts: 1730000001000,
      data: {
        message: {
          role: 'assistant',
          stop: 'end_turn',
          content: [{ type: 'text', data: { text: 'all swept' } }],
        },
      },
    },
  ],
}

let runsReply: Run[]
const requested: string[] = []

describe('RunsHistory', () => {
  let sockets: MockWebSocket[]

  beforeEach(() => {
    localStorage.clear()
    runsReply = runs
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
    requested.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '')
        const base = path.split('?')[0]
        if (!init?.method || init.method === 'GET') requested.push(path)
        if (base === '/api/me')
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        if (base === '/api/sessions') {
          return Promise.resolve(
            Response.json([
              {
                sessionId: '01LIVE0000000000',
                name: 'live one',
                state: 'online',
                spawnedBy: 'swarm',
              },
            ]),
          )
        }
        if (base === '/api/attention' || base === '/api/models/options')
          return Promise.resolve(Response.json([]))
        if (base === '/api/jobs') {
          const jobParam = new URLSearchParams(path.split('?')[1] ?? '').get('job')
          return Promise.resolve(
            Response.json(jobParam !== null ? jobs.filter((j) => j.id === Number(jobParam)) : jobs),
          )
        }
        if (base === '/api/runs') {
          const jobParam = new URLSearchParams(path.split('?')[1] ?? '').get('job')
          return Promise.resolve(
            Response.json(
              jobParam !== null ? runsReply.filter((r) => r.jobId === Number(jobParam)) : runsReply,
            ),
          )
        }
        if (/\/api\/saved-sessions\/[^/]+\/entries/.test(base)) {
          return Promise.resolve(Response.json(savedPage))
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )
  })

  afterEach(() => {
    sockets = []
    vi.unstubAllGlobals()
  })

  function renderRuns(initialEntry = '/jobs/runs') {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            <Routes>
              <Route path="/jobs/runs" element={<RunsHistory />} />
              <Route path="*" element={<div>elsewhere</div>} />
            </Routes>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  it('renders rows joined with job names, durations and errors', async () => {
    renderRuns()

    await screen.findByTestId('run-11')
    const failedRow = screen.getByTestId('run-12')
    expect(failedRow.textContent).toContain('weekly')
    expect(failedRow.textContent).toContain('failed')
    // the live run's row shows its job's name
    expect(screen.getByTestId('run-11').textContent).toContain('nightly')

    // the skipped run with no session id still lists
    expect(screen.getByTestId('run-13')).toBeInTheDocument()
  })

  it('carries full text in tooltips where rows truncate', async () => {
    const prompt =
      'sweep every log under /var/log, drop the rotated ones, and summarize the outliers for the nightly report'
    const error = 'submit refused: dialog holds input because a previous dialog never resolved'
    // five minutes back keeps the recency label clear of its unit boundaries
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString()
    runsReply = [{ ...runs[1], id: 21, startedAt, prompt, error }]
    renderRuns()

    const row = await screen.findByTestId('run-21')
    // the slice stays, the tooltip carries what the clipped cell hides
    const promptCell = row.querySelector('.run-prompt-cell')
    expect(promptCell).toHaveAttribute('title', prompt)
    expect(promptCell).toHaveTextContent(prompt.slice(0, 80))
    expect(row.querySelector('.run-error-excerpt')).toHaveAttribute('title', error)

    // Started reads as a recency label with the zone-suffixed absolute behind it
    const started = within(row).getByTitle(formatTimestamp(startedAt))
    expect(started).toHaveTextContent(relativeTimestamp(startedAt))
  })

  it('shows the empty state', async () => {
    runsReply = []
    renderRuns()

    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument()
  })

  it('surfaces load failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ error: 'internal_error' }, { status: 500 }))),
    )
    renderRuns()

    expect(await screen.findByRole('alert')).toHaveTextContent('internal_error')
  })

  it('filters by status client-side and by job through the backend', async () => {
    const user = userEvent.setup()
    renderRuns()
    await screen.findByTestId('run-11')

    await user.selectOptions(screen.getByLabelText(/^Status/), 'skipped')
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
    expect(screen.getByTestId('run-13')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText(/Job/), '6')
    await waitFor(() => {
      expect(requested.some((u) => u.includes('job=6'))).toBe(true)
    })
    // the narrowed fetch left only job 6's run under the status filter reset
    await user.selectOptions(screen.getByLabelText(/^Status/), '')
    await waitFor(() => {
      expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
      expect(screen.getByTestId('run-12')).toBeInTheDocument()
    })
  })

  it('links a live run to its session view', async () => {
    const user = userEvent.setup()
    renderRuns()
    await screen.findByTestId('run-11')

    await act(async () => sockets[0]?.open())
    await user.click(screen.getByTestId('run-11'))

    const link = await screen.findByRole('link', { name: 'Open session view' })
    expect(link).toHaveAttribute('href', '/s/01LIVE0000000000')
  })

  it('renders a finished offline transcript inline', async () => {
    const user = userEvent.setup()
    renderRuns()
    await screen.findByTestId('run-11')

    await user.click(screen.getByTestId('run-12'))
    expect(await screen.findByRole('dialog', { name: 'Run 12' })).toBeInTheDocument()

    // the offline preview renders the recorded branch through the shared blocks
    expect(await screen.findByText('all swept')).toBeInTheDocument()
    expect(screen.getByText('run the sweep')).toBeInTheDocument()
    expect(
      requested.some((u) => u.startsWith('/api/saved-sessions/01OFFLINE00000000/entries')),
    ).toBe(true)
  })

  it('keeps an open detail fresh', async () => {
    const user = userEvent.setup()
    runsReply = [
      {
        id: 14,
        jobId: 5,
        sessionId: '01LIVE0000000000',
        prompt: 'sweep now',
        trigger: 'schedule',
        status: 'running',
        startedAt: new Date().toISOString(),
      },
    ]
    renderRuns()
    await screen.findByTestId('run-14')

    await user.click(screen.getByTestId('run-14'))
    expect(screen.getByRole('dialog', { name: 'Run 14' })).toBeInTheDocument()
    expect(screen.getByTestId('detail-status')).toHaveTextContent('running')

    // the next poll reports completion: the modal resolves its run from the
    // fresh list, so status and finished time update without reopening
    runsReply = [{ ...runsReply[0], status: 'ok', finishedAt: new Date().toISOString() }]
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => {
      expect(screen.getByTestId('detail-status')).toHaveTextContent('ok')
    })
    expect(screen.getByRole('dialog', { name: 'Run 14' })).toBeInTheDocument()
  })

  it('closes detail of vanished runs', async () => {
    const user = userEvent.setup()
    renderRuns()
    await screen.findByTestId('run-13')

    await user.click(screen.getByTestId('run-13'))
    expect(screen.getByRole('dialog', { name: 'Run 13' })).toBeInTheDocument()

    // a run outside the fetched window or deleted server-side closes its modal
    runsReply = [runs[0], runs[1]]
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Run 13' })).not.toBeInTheDocument()
    })
  })

  it('commits only the newest load', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    // /api/runs replies park until released; this mock ignores abort, so a
    // superseded reply can still land late, which is what the commit guard
    // must reject.
    const parked: Array<{ job: string | null; resolve: (r: Response) => void }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '')
        const base = path.split('?')[0]
        if (!init?.method || init.method === 'GET') requested.push(path)
        if (base === '/api/me')
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        if (
          base === '/api/sessions' ||
          base === '/api/attention' ||
          base === '/api/models/options'
        ) {
          return Promise.resolve(Response.json([]))
        }
        if (base === '/api/jobs') return Promise.resolve(Response.json(jobs))
        if (base === '/api/runs') {
          const job = new URLSearchParams(path.split('?')[1] ?? '').get('job')
          signals.push(init?.signal)
          return new Promise<Response>((resolve) => {
            parked.push({ job, resolve })
          })
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )

    renderRuns()
    await waitFor(() => expect(parked).toHaveLength(1))
    parked[0].resolve(Response.json(runs)) // the initial all-jobs load commits
    await screen.findByTestId('run-11')

    // a poll tick parks with the old filter, then the select narrows to job 6:
    // the superseded tick is aborted outright and never commits over it
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText(/Job/), '6')
    expect(signals).toHaveLength(3)
    expect(signals[1]?.aborted).toBe(true)

    // the newest reply lands first and commits; the stale all-jobs reply that
    // follows must not repaint another job's rows under the narrowed select
    parked[2].resolve(Response.json([runs[1]]))
    await screen.findByTestId('run-12')
    parked[1].resolve(Response.json(runs))
    await waitFor(() => {
      expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
      expect(screen.getByTestId('run-12')).toBeInTheDocument()
    })
  })

  it('swallows aborted loads silently', async () => {
    const parked: Array<{ resolve: (r: Response) => void }> = []
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
        if (base === '/api/jobs') return Promise.resolve(Response.json(jobs))
        if (base === '/api/runs') {
          // parked like a real fetch, rejecting only when its signal aborts
          return new Promise<Response>((resolve, reject) => {
            parked.push({ resolve })
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            })
          })
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )

    renderRuns()
    await waitFor(() => expect(parked).toHaveLength(1))
    parked[0].resolve(Response.json(runs))
    await screen.findByTestId('run-11')

    // aborting a superseded poll tick must not flash an error banner while
    // the filter change's own load is still in flight
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText(/Job/), '6')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0)) // flush the rejection
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    parked[2].resolve(Response.json([runs[1]]))
    await screen.findByTestId('run-12')
  })
})
