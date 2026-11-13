import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TitleModelSelect } from './TitleModelSelect'
import type { ModelState } from '../api/types'

// The swarm-level titling model picker: registry union options grouped per
// provider, the default selection for an unset value, a stored-but-missing
// model flagged rather than silently dropped, and a null payload (older
// server) degrading to the default entry instead of crashing.
const model = (key: string, short: string): ModelState => ({
  key,
  short,
  window: 0,
  caps: { reasoning: false, images: false, parallelToolCalls: false },
})

const REGISTRY = [model('a/sonnet', 'sonnet'), model('a/haiku', 'haiku')]

afterEach(() => {
  vi.unstubAllGlobals()
})

function mockBackend(
  stored: string,
  put?: (model: string) => Response,
  registry: ModelState[] | null = REGISTRY,
) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).split('?')[0]
    if (path === '/api/settings') {
      if (init?.method === 'PUT')
        return put?.(JSON.parse(String(init.body)).titleModel) ?? Response.json({})
      return Response.json({ titleModel: stored })
    }
    if (path === '/api/models/options') return Response.json(registry)
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

  it('groups options per provider and keeps the full key as the value', async () => {
    // same short name under two providers plus a bare key with no slash
    vi.stubGlobal(
      'fetch',
      mockBackend('z/gone', undefined, [
        model('anthropic/sonnet', 'sonnet'),
        model('openai/sonnet', 'sonnet'),
        model('local-tuned', 'local-tuned'),
      ]),
    )
    render(<TitleModelSelect />)

    const select = await screen.findByLabelText('Session titling model')
    expect(select).toHaveValue('z/gone')
    const groups = [...select.querySelectorAll('optgroup')]
    expect(groups.map((g) => g.getAttribute('label'))).toEqual(['anthropic', 'openai'])
    // every option keeps its full key as the value, inside or outside a group
    expect([...select.querySelectorAll('option')].map((o) => o.value)).toEqual([
      '',
      'anthropic/sonnet',
      'openai/sonnet',
      'local-tuned',
      'z/gone',
    ])
    // keys without a provider prefix and the stored-but-missing model render
    // ungrouped with their full key text
    const topLevel = [...select.children].filter((el) => el.tagName === 'OPTION')
    expect(topLevel.map((o) => o.textContent)).toEqual([
      'Session model (default)',
      'local-tuned',
      'z/gone (missing)',
    ])
  })

  it('degrades a null options payload to the default entry', async () => {
    vi.stubGlobal('fetch', mockBackend('', undefined, null))
    render(<TitleModelSelect />)

    const select = await screen.findByLabelText('Session titling model')
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Session model (default)',
    ])
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
    // ApiError renders through describeError, which keeps the server detail
    await screen.findByText('writing the setting failed')
    // the failed pick never moved the stored value
    expect(screen.getByLabelText('Session titling model')).toHaveValue('')
  })
})
