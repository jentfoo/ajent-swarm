import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import RunsHistory from './RunsHistory'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'
import { MockWebSocket } from '../test/mockWebSocket'
import { stubPhoneLayout } from '../test/matchMedia'
import { formatTimestamp, relativeTimestamp } from '../jobs/schedule'
import type { Job, Run } from '../api/types'

// Run history renders over the real provider stack: rows join job names,
// filters narrow through the backend's ?job= and client-side status, the
// filters live in the URL so deep links and history navigation restore them,
// a first load paints a loading line instead of a blank panel, a run's detail
// routes to its session view when live or its recorded transcript when not,
// an open detail tracks each poll instead of a frozen snapshot, only the
// newest load may commit over an in-flight one, and platform back peels the
// detail as its own history layer.
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

// NavProbe exposes the current search string and the last navigation type, so
// filter tests can observe the URL and the replace-vs-push choice without
// reaching into the router.
function NavProbe(): ReactElement {
  const navType = useNavigationType()
  return (
    <div data-testid="probe">
      <span data-testid="search">{useLocation().search}</span>
      <span data-testid="nav-type">{navType}</span>
    </div>
  )
}

// NavButton and BackButton drive MemoryRouter between URLs directly, standing
// in for the browser navigation that keeps one RunsHistory instance mounted.
function NavButton({ to, children }: { to: string; children: string }): ReactElement {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(to)}>
      {children}
    </button>
  )
}

function BackButton({ children }: { children: string }): ReactElement {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(-1)}>
      {children}
    </button>
  )
}

describe('RunsHistory', () => {
  let sockets: MockWebSocket[]

  beforeEach(() => {
    localStorage.clear()
    runsReply = runs
    // a consume queued by the previous test's cleanup never navigated in jsdom
    // drain its pending pop event so it cannot swallow this test's own
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.dispatchEvent(new PopStateEvent('popstate'))
    window.history.replaceState(null, '', window.location.href)
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function renderRuns(initialEntry = '/jobs/runs', nav?: ReactElement) {
    return render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>
              {nav}
              <Routes>
                <Route
                  path="/jobs/runs"
                  element={
                    <>
                      <NavProbe />
                      <RunsHistory />
                    </>
                  }
                />
                <Route path="*" element={<div>elsewhere</div>} />
              </Routes>
            </WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
  }

  const runsFetches = () => requested.filter((u) => u.startsWith('/api/runs'))

  it('titles the tab after the route', () => {
    renderRuns()

    expect(document.title).toBe('Run history · ajent-swarm')
  })

  it('sizes the page title through the shared class, no inline override', () => {
    renderRuns()

    const title = screen.getByRole('heading', { level: 1, name: 'Run history' })
    expect(title).toHaveClass('page-title')
    // theme.css owns the scale; the old body-size inline reset is gone
    expect(title).not.toHaveAttribute('style')
  })

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

    expect(
      await screen.findByText('No runs yet. Fire a job or wait for its schedule.'),
    ).toBeInTheDocument()
  })

  it('names the empty scope for a job filter', async () => {
    runsReply = []
    renderRuns()
    const user = userEvent.setup()
    await screen.findByText(/No runs yet/)

    await user.selectOptions(screen.getByLabelText(/Job/), '6')
    expect(
      await screen.findByText('No runs for weekly yet. Fire it or wait for its schedule.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/No runs yet/)).not.toBeInTheDocument()
  })

  it('scopes a status miss to the latest history', async () => {
    renderRuns() // no run carries the timeout status in the fixture window
    const user = userEvent.setup()
    await screen.findByTestId('run-11')

    await user.selectOptions(screen.getByLabelText(/^Status/), 'timeout')
    expect(screen.getByText('No timeout runs in the latest history.')).toBeInTheDocument()

    // the job-scoped miss names the job over the same window
    await user.selectOptions(screen.getByLabelText(/Job/), '6')
    expect(
      await screen.findByText('No timeout runs for weekly in the latest history.'),
    ).toBeInTheDocument()
  })

  it('scopes a status miss over a full latest page', async () => {
    // 200 ok runs fill the fetched window: a miss there cannot speak for
    // all-time, older matching runs may sit past the page
    const page = Array.from({ length: 200 }, (_, i) => ({
      ...runs[0],
      id: i + 100,
      status: 'ok' as const,
    }))
    runsReply = page
    renderRuns()
    const user = userEvent.setup()
    await screen.findByTestId('run-100')

    await user.selectOptions(screen.getByLabelText(/^Status/), 'failed')
    expect(screen.getByText('No failed runs in the latest history.')).toBeInTheDocument()
    expect(screen.queryByText('No runs yet')).not.toBeInTheDocument()
  })

  it('keeps the desktop table above the phone breakpoint', async () => {
    renderRuns()

    expect(await screen.findByTestId('run-11')).toHaveProperty('tagName', 'TR')
    expect(document.querySelector('.runs-table')).not.toBeNull()
    expect(document.querySelector('.run-card')).toBeNull()
  })

  it('renders each run as one card on phones', async () => {
    const user = userEvent.setup()
    const prompt =
      'sweep every log under /var/log, drop the rotated ones, and summarize the outliers for the nightly report'
    const error = 'submit refused: dialog holds input because a previous dialog never resolved'
    stubPhoneLayout()
    runsReply = [{ ...runs[1], id: 22, prompt, error }]
    renderRuns()

    const card = await screen.findByTestId('run-22')
    expect(card).toHaveClass('run-card')
    expect(card.textContent).toContain('weekly') // the joined job name
    expect(card.textContent).toContain('failed') // the status beside the name
    expect(document.querySelector('.runs-table')).toBeNull()

    // the card wraps the full prompt and error where the table clips to 80
    expect(card.textContent).toContain(prompt)
    expect(card.textContent).toContain(error)

    // tapping the card opens the detail through the same path as a row click
    await user.click(card)
    expect(await screen.findByRole('dialog', { name: 'Run 22' })).toBeInTheDocument()
  })

  it('filters cards and opens details on phones', async () => {
    const user = userEvent.setup()
    stubPhoneLayout()
    renderRuns()
    await screen.findByTestId('run-11')

    await user.selectOptions(screen.getByLabelText(/^Status/), 'failed')
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
    expect(screen.getByTestId('run-12')).toBeInTheDocument()

    // the card's own action row carries the open path at a touch-sized floor
    await user.click(within(screen.getByTestId('run-12')).getByRole('button', { name: 'Details' }))
    expect(await screen.findByRole('dialog', { name: 'Run 12' })).toBeInTheDocument()
  })

  it('shows a loading line before rows land', async () => {
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
          // parked like a real fetch, so the first paint stays on its load
          return new Promise<Response>((resolve) => {
            parked.push({ resolve })
          })
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )

    renderRuns()
    const loading = screen.getByText('Loading run history…')
    expect(loading).toHaveAttribute('role', 'status')
    expect(loading).toHaveAttribute('aria-busy', 'true')

    parked[0].resolve(Response.json(runs))
    await screen.findByTestId('run-11')
    expect(screen.queryByText('Loading run history…')).not.toBeInTheDocument()
  })

  it('surfaces load failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ error: 'internal_error' }, { status: 500 }))),
    )
    renderRuns()

    expect(await screen.findByRole('alert')).toHaveTextContent('The service hit an internal error.')
    // the failed first load keeps its alert, never a loading line beneath it
    expect(screen.queryByText('Loading run history…')).not.toBeInTheDocument()
  })

  it('renders rows even when job names fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const path = String(url).replace(/^https?:\/\/[^/]+/, '')
        const base = path.split('?')[0]
        if (base === '/api/me')
          return Promise.resolve(Response.json({ username: 'you', via: 'cookie' }))
        if (base === '/api/sessions') return Promise.resolve(Response.json([]))
        if (base === '/api/attention' || base === '/api/models/options') {
          return Promise.resolve(Response.json([]))
        }
        if (base === '/api/jobs') {
          return Promise.resolve(Response.json({ error: 'internal_error' }, { status: 500 }))
        }
        if (base === '/api/runs') {
          const jobParam = new URLSearchParams(path.split('?')[1] ?? '').get('job')
          return Promise.resolve(
            Response.json(
              jobParam !== null ? runsReply.filter((r) => r.jobId === Number(jobParam)) : runsReply,
            ),
          )
        }
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${base}`)
      }),
    )
    renderRuns()

    // the primary history renders without an alert, the name join falls to
    // the dash until a poll lands the names
    await screen.findByTestId('run-11')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('run-11')).getByText('—')).toBeInTheDocument()
    expect(within(screen.getByTestId('run-12')).getByText('—')).toBeInTheDocument()
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

  it('narrows by job name, prompt and error text', async () => {
    renderRuns()
    const user = userEvent.setup()
    await screen.findByTestId('run-11')

    // the joined job's name
    await user.type(screen.getByRole('searchbox', { name: 'Filter runs' }), 'WEEKLY')
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
    expect(screen.getByTestId('run-12')).toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: 'Filter runs' }))

    // prompt text
    await user.type(screen.getByRole('searchbox', { name: 'Filter runs' }), 'sweep now')
    expect(await screen.findByTestId('run-11')).toBeInTheDocument()
    expect(screen.queryByTestId('run-12')).not.toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: 'Filter runs' }))

    // error text
    await user.type(screen.getByRole('searchbox', { name: 'Filter runs' }), 'still active')
    expect(await screen.findByTestId('run-13')).toBeInTheDocument()
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
  })

  it('round-trips a query through the URL without refetching', async () => {
    renderRuns('/jobs/runs?q=sweep')
    const user = userEvent.setup()

    // the first fetch already carries the job scope, no all-runs request runs
    // first, and the text filter never asks for another
    expect(runsFetches()).toHaveLength(1)
    const box = await screen.findByRole('searchbox', { name: 'Filter runs' })
    expect(box).toHaveValue('sweep')
    expect(await screen.findByTestId('run-11')).toBeInTheDocument()
    expect(screen.queryByTestId('run-12')).not.toBeInTheDocument()

    // typing rewrites the parameter with replace, client-side only
    await user.type(box, ' now')
    expect(screen.getByRole('searchbox', { name: 'Filter runs' })).toHaveValue('sweep now')
    expect(screen.getByTestId('search').textContent).toContain('q=sweep')
    expect(screen.getByTestId('nav-type')).toHaveTextContent('REPLACE')
    expect(runsFetches()).toHaveLength(1)
  })

  it('combines status and text filters in the count', async () => {
    renderRuns()
    const user = userEvent.setup()
    await screen.findByTestId('run-11')

    // the count waits out the first load, then reads every run
    expect(await screen.findByText('3 of 3 runs')).toBeInTheDocument()

    // status first, then the query: one combined scope
    await user.selectOptions(screen.getByLabelText(/^Status/), 'failed')
    await screen.findByText('1 of 3 runs')

    await user.type(screen.getByRole('searchbox', { name: 'Filter runs' }), 'zzz')
    await screen.findByText('0 of 3 runs')
  })

  it('names the query on a miss under one job', async () => {
    renderRuns('/jobs/runs?job=6&q=zzz')

    // weekly has runs, the query filtered them out, so the copy must not read
    // as an untouched history
    expect(
      await screen.findByText('No runs match “zzz” in the latest history.'),
    ).toBeInTheDocument()
  })

  it('offers clear filters on a miss and resets all three', async () => {
    renderRuns('/jobs/runs?job=6&status=failed&q=zzz')
    const user = userEvent.setup()

    expect(
      await screen.findByText('No failed runs for weekly in the latest history.'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByTestId('run-11')).toBeInTheDocument()
    expect(screen.getByLabelText(/Job/)).toHaveValue('')
    expect(screen.getByLabelText(/^Status/)).toHaveValue('')
    expect(screen.getByRole('searchbox', { name: 'Filter runs' })).toHaveValue('')
    // the plain route returns, only non-defaults serialize
    expect(screen.getByTestId('search').textContent).toBe('')
  })

  it('initializes filters from a deep-linked URL', async () => {
    renderRuns('/jobs/runs?job=6&status=failed')

    // the first fetch already carries the filter, no all-jobs request runs first
    expect(runsFetches()).toHaveLength(1)
    expect(runsFetches()[0]).toContain('job=6')
    expect(await screen.findByTestId('run-12')).toBeInTheDocument()
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Job/)).toHaveValue('6')
    expect(screen.getByLabelText(/^Status/)).toHaveValue('failed')
  })

  it('replaces URL parameters on filter changes', async () => {
    renderRuns()
    const user = userEvent.setup()
    await screen.findByTestId('run-11')
    expect(runsFetches()).toHaveLength(1)

    await user.selectOptions(screen.getByLabelText(/Job/), '6')
    await waitFor(() => expect(runsFetches()).toHaveLength(2))
    expect(runsFetches().at(-1)).toContain('job=6')
    expect(screen.getByTestId('search')).toHaveTextContent('?job=6')
    // replace keeps the poll's filter edits out of the browser-back trail
    expect(screen.getByTestId('nav-type')).toHaveTextContent('REPLACE')

    // status is client-side: it rewrites the URL without another fetch
    await user.selectOptions(screen.getByLabelText(/^Status/), 'failed')
    expect(screen.getByTestId('search')).toHaveTextContent('?job=6&status=failed')
    expect(runsFetches()).toHaveLength(2)
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()

    // clearing both leaves the plain route: only non-defaults serialize
    await user.selectOptions(screen.getByLabelText(/Job/), '')
    await waitFor(() => expect(runsFetches()).toHaveLength(3))
    await user.selectOptions(screen.getByLabelText(/^Status/), '')
    expect(await screen.findByTestId('run-11')).toBeInTheDocument()
    expect(screen.getByTestId('search').textContent).toBe('')
  })

  it('follows back and forward onto changed URLs', async () => {
    renderRuns(
      '/jobs/runs',
      <>
        <NavButton to="/jobs/runs?job=6">to weekly</NavButton>
        <BackButton>back one</BackButton>
      </>,
    )
    await screen.findByTestId('run-11')
    const user = userEvent.setup()

    // navigation onto a filtered URL reloads under that filter, the same
    // instance stays mounted
    await user.click(screen.getByRole('button', { name: 'to weekly' }))
    expect(await screen.findByTestId('run-12')).toBeInTheDocument()
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/Job/)).toHaveValue('6')

    // back restores the plain URL and its rows through exactly one reload
    await user.click(screen.getByRole('button', { name: 'back one' }))
    expect(await screen.findByTestId('run-11')).toBeInTheDocument()
    expect(screen.getByLabelText(/Job/)).toHaveValue('')
    expect(runsFetches()).toHaveLength(3)
  })

  it.each(['abc', '0', '-5', '5.5', ''])('treats job param %s as All', async (raw) => {
    renderRuns(`/jobs/runs?job=${raw}`)

    // no NaN ever reaches the API, the validated id falls back to All
    expect(runsFetches()).toHaveLength(1)
    expect(runsFetches()[0]).not.toContain('job=')
    expect(await screen.findByTestId('run-13')).toBeInTheDocument()
    expect(screen.getByLabelText(/Job/)).toHaveValue('')
  })

  it.each(['bogus', 'FAILED'])('treats status param %s as All', async (raw) => {
    renderRuns(`/jobs/runs?status=${raw}`)

    // an unknown status falls back to All, every row still shows
    expect(await screen.findByTestId('run-11')).toBeInTheDocument()
    expect(screen.getByTestId('run-13')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Status/)).toHaveValue('')
  })

  it('keeps a deep-linked deleted job visible', async () => {
    renderRuns('/jobs/runs?job=999')

    // the select holds the id while the names load, then names it gone
    await waitFor(() =>
      expect(screen.getByRole('option', { name: '#999 (deleted)' })).toBeInTheDocument(),
    )
    expect(screen.getByLabelText(/Job/)).toHaveValue('999')
    expect(
      screen.getByText('No runs for this job yet. Fire it or wait for its schedule.'),
    ).toBeInTheDocument()
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

  it('peels an open detail on platform back', async () => {
    const user = userEvent.setup()
    renderRuns()
    await screen.findByTestId('run-11')

    // a narrowed filter makes surviving state observable after the close
    await user.selectOptions(screen.getByLabelText(/^Status/), 'failed')
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('run-12'))
    expect(screen.getByRole('dialog', { name: 'Run 12' })).toBeInTheDocument()

    // the gesture pops the detail's own history entry, not the route: the
    // modal peels and /jobs/runs keeps its filters and rows
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(screen.queryByRole('dialog', { name: 'Run 12' })).not.toBeInTheDocument()
    expect(screen.getByTestId('run-12')).toBeInTheDocument()
    expect(screen.queryByTestId('run-11')).not.toBeInTheDocument()
  })

  it('consumes its history entry when closed from inside', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const user = userEvent.setup()
    renderRuns()
    await screen.findByTestId('run-11')

    await user.click(screen.getByTestId('run-12'))
    expect(screen.getByRole('dialog', { name: 'Run 12' })).toBeInTheDocument()

    // closing through the modal itself steps back over its entry, so a later
    // platform back never replays this close, mocked inert because jsdom
    // delivers the traversal as a task
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Run 12' })).not.toBeInTheDocument()
    expect(back).toHaveBeenCalledTimes(1)
    act(() => window.dispatchEvent(new PopStateEvent('popstate'))) // settle the consume
  })

  it('commits only the newest load', async () => {
    const signals: Array<AbortSignal | null | undefined> = []
    // /api/runs replies park until released, this mock ignores abort, so a
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

    // the newest reply lands first and commits, the stale all-jobs reply that
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
