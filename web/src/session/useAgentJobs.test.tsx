import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAgentJobs } from './useAgentJobs'
import type { AgentJob, ActivityRow, Segment } from '../api/types'

// The pull contract: agents.list fires only while sub-agent work is live,
// re-lists on its cadence, treats the coded unavailable answer as "no
// surfaces" rather than an error, and a stop re-lists right after.

function row(key: string, rank = 0): ActivityRow {
  return { key, text: `${key}  working`, rank }
}

function segment(text: string, counts?: Record<string, number>): Segment[] {
  return [{ key: 'subagents', text, order: 40, counts }]
}

function job(id: string, status: AgentJob['status'], elapsedMs?: number): AgentJob {
  return { id, status, elapsedMs }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Parks every fetch reply until the test resolves it in arrival order.
function parkFetches(): Array<(res: Response) => void> {
  const parked: Array<(res: Response) => void> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Promise<Response>((resolve) => {
        parked.push(resolve)
      })
    }),
  )
  return parked
}

// Harness forwards live props so rerenders can flip the pull condition.
type HarnessProps = {
  activity?: ActivityRow[]
  segments?: Segment[]
  onToast?: (text: string, level?: 'info' | 'error') => void
}

const sessionId = '01AGENTS00000000000'

function mount(props: HarnessProps = {}) {
  return renderHook(
    (p: HarnessProps) => useAgentJobs(sessionId, p.activity, p.segments, p.onToast),
    { initialProps: props },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useAgentJobs', () => {
  it('keys records while live', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ jobs: [job('sub-1', 'running', 1200), job('sub-2', 'done')] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = mount({ activity: [row('sub-1')] })
    await waitFor(() => expect(result.current.byId.size).toBe(2))
    expect(result.current.byId.get('sub-2')?.status).toBe('done')
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/sessions/${sessionId}/agents`)
  })

  it('stays idle without live work', () => {
    const fetchMock = vi.fn(async () => jsonResponse({ jobs: [] }))
    vi.stubGlobal('fetch', fetchMock)

    mount({ segments: segment('subagents: 4 done', { done: 4 }) })
    expect(fetchMock).not.toHaveBeenCalled() // done-only tallies never pull
  })

  it('relists on its cadence', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => jsonResponse({ jobs: [job('sub-1', 'running')] }))
    vi.stubGlobal('fetch', fetchMock)

    mount({ activity: [row('sub-1')] })
    expect(fetchMock).toHaveBeenCalledTimes(1) // the first list is immediate
    await act(() => vi.advanceTimersByTimeAsync(3000))
    await act(() => vi.advanceTimersByTimeAsync(3000))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops pulling when work ends', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ jobs: [job('sub-1', 'done')] }))
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = mount({ activity: [row('sub-1')] })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    // upstream cleared the rows at the job's end: the next render stops the pull
    rerender({ activity: [] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hides surfaces when unavailable', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'unavailable', message: 'sub-agents not available' }, 409),
    )
    vi.stubGlobal('fetch', fetchMock)
    const onToast = vi.fn()

    const { result } = mount({ activity: [row('sub-1')], onToast })
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry against unwired sessions
    expect(onToast).not.toHaveBeenCalled()
  })

  it('stops one job and relists', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/agents/stop')) {
        return jsonResponse({ stopped: 1 })
      }
      return jsonResponse({ jobs: [job('sub-2', 'aborted')] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = mount({ activity: [row('sub-2')] })
    await waitFor(() => expect(result.current.byId.size).toBe(1))

    act(() => result.current.stop('sub-2'))
    await waitFor(() => expect(result.current.stopping).toBe(false))
    const stop = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agents/stop'))
    expect(stop).toBeDefined()
    expect(JSON.parse(String(stop![1]?.body))).toEqual({ id: 'sub-2' })
    // the follow-up list landed the aborted record
    expect(result.current.byId.get('sub-2')?.status).toBe('aborted')
  })

  it('stops all without an id', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/agents/stop')) {
        return jsonResponse({ stopped: 2 })
      }
      return jsonResponse({ jobs: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = mount({ activity: [row('sub-1'), row('sub-2')] })
    await waitFor(() => expect(result.current.byId.size).toBe(0))

    act(() => result.current.stop())
    await waitFor(() => expect(result.current.stopping).toBe(false))
    const stop = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agents/stop'))
    expect(JSON.parse(String(stop![1]?.body))).toEqual({ all: true })
  })

  it('toasts a refused stop', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/agents/stop')) {
        return jsonResponse({ error: 'observer', message: 'seat held by terminator' }, 409)
      }
      return jsonResponse({ jobs: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onToast = vi.fn()

    const { result } = mount({ activity: [row('sub-1')], onToast })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    act(() => result.current.stop('sub-1'))
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('observer: seat held by terminator', 'error'),
    )
  })

  it('commits only the newest list reply', async () => {
    const parked = parkFetches()

    const { result } = mount({ activity: [row('sub-1')] })
    expect(parked).toHaveLength(1)

    // a visibility relist overlaps the still-pending pull
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(parked).toHaveLength(2)

    // the newer reply commits, then the older pull lands late and must drop,
    // or finished jobs would repaint over running ones until the next tick
    parked[1](jsonResponse({ jobs: [job('sub-1', 'running')] }))
    await waitFor(() => expect(result.current.byId.get('sub-1')?.status).toBe('running'))

    await act(async () => {
      parked[0](jsonResponse({ jobs: [job('sub-1', 'done'), job('sub-2', 'done')] }))
    })
    expect(result.current.byId.size).toBe(1)
    expect(result.current.byId.get('sub-1')?.status).toBe('running')
  })

  it('keeps surfaces up over a stale unavailable', async () => {
    const parked = parkFetches()

    const { result } = mount({ activity: [row('sub-1')] })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(parked).toHaveLength(2)

    // the newer reply lists a live job; the stale pull's coded unavailable
    // answer lands last and must not hide the surfaces
    parked[1](jsonResponse({ jobs: [job('sub-1', 'running')] }))
    await waitFor(() => expect(result.current.byId.get('sub-1')?.status).toBe('running'))

    await act(async () => {
      parked[0](jsonResponse({ error: 'unavailable', message: 'sub-agents not available' }, 409))
    })
    expect(result.current.available).toBe(true)
    expect(result.current.byId.size).toBe(1)
  })
})
