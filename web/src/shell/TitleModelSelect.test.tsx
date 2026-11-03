import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TitleModelSelect } from './TitleModelSelect'

// The swarm-level titling model picker: registry union options, the default
// selection for an unset value, and a stored-but-missing model flagged rather
// than silently dropped.
const REGISTRY = [
  { key: 'a/sonnet', short: 'sonnet', window: 0, caps: {} },
  { key: 'a/haiku', short: 'haiku', window: 0, caps: {} },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockBackend(stored: string, put?: (model: string) => Response) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0]
    if (path === '/api/settings') {
      if (init?.method === 'PUT')
        return put?.(JSON.parse(String(init.body)).titleModel) ?? Response.json({})
      return Response.json({ titleModel: stored })
    }
    if (path === '/api/models/options') return Response.json(REGISTRY)
    throw new Error(`unexpected fetch ${String(url)}`)
  })
}

describe('TitleModelSelect', () => {
  it('reads the stored model and lists the registry beside the default', async () => {
    vi.stubGlobal('fetch', mockBackend('a/haiku'))
    render(<TitleModelSelect />)

    const select = await screen.findByLabelText('Session titling model')
    expect(select).toHaveValue('a/haiku')
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Session model (default)',
      'sonnet',
      'haiku',
    ])
  })

  it('flags a stored model that has gone missing from the registries', async () => {
    vi.stubGlobal('fetch', mockBackend('a/gone'))
    render(<TitleModelSelect />)

    const select = await screen.findByLabelText('Session titling model')
    expect(select).toHaveValue('a/gone')
    expect(screen.getByText('a/gone (missing)')).toBeInTheDocument()
  })

  it('saves the pick and switches to the default', async () => {
    const fetchSpy = mockBackend('', (model) => Response.json({ titleModel: model }))
    vi.stubGlobal('fetch', fetchSpy)
    render(<TitleModelSelect />)

    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('Session titling model'), 'a/sonnet')
    await vi.waitFor(() => {
      const puts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(JSON.parse(String(puts[0]![1]?.body)).titleModel).toBe('a/sonnet')
    })
    expect(screen.getByLabelText('Session titling model')).toHaveValue('a/sonnet')

    await user.selectOptions(screen.getByLabelText('Session titling model'), '')
    await vi.waitFor(() => {
      const puts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT')
      expect(puts).toHaveLength(2)
      expect(JSON.parse(String(puts[1]![1]?.body)).titleModel).toBe('')
    })
  })

  it('surfaces a refused save as an error without losing the selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).split('?')[0]
        if (path === '/api/settings') {
          if (init?.method === 'PUT') {
            return Response.json(
              { error: 'internal_error', message: 'writing the setting failed' },
              { status: 500 },
            )
          }
          return Response.json({ titleModel: '' })
        }
        if (path === '/api/models/options') return Response.json(REGISTRY)
        throw new Error(`unexpected fetch ${String(url)}`)
      }),
    )
    render(<TitleModelSelect />)

    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('Session titling model'), 'a/sonnet')
    // ApiError renders as code: message
    expect(
      await screen.findByText('internal_error: writing the setting failed'),
    ).toBeInTheDocument()
    // the failed pick never moved the stored value
    expect(screen.getByLabelText('Session titling model')).toHaveValue('')
  })
})
