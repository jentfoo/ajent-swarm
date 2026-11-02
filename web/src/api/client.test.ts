import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, onUnauthorized, request } from './client'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('request', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unwraps JSON bodies and leaves 204 as undefined', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { username: 'you' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(request('/api/me')).resolves.toEqual({ username: 'you' })
    await expect(request<void>('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('surfaces the structured error body as an ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { error: 'seat-held', message: 'held by human-2' }),
    )
    const err = await request('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'seat-held', detail: 'held by human-2' })
  })

  it('falls back to a generic code when the body is not an envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 500 }))
    const err = await request('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 500, code: 'unknown_error' })
  })

  it('notifies listeners once per unauthorized response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }))
    const seen: number[] = []
    const off = onUnauthorized(() => seen.push(1))
    await request('/api/sessions').catch(() => undefined)
    expect(seen).toEqual([1])
    off()
  })
})
