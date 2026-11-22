import { act, renderHook, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chainPreview, defaultChildPrompt, useChainForm } from './useChainForm'
import type { Chain } from '../api/types'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// The shared chain form model: the preview composes the exact child line
// with the default continuation standing in for an empty prompt, edits carry
// the existing record, and the submit sends the effective prompt.

const PARENT = '01PARENTSESSION00000A'
const CHILD = '01CHILDSESSION00000B'

describe('chain form helpers', () => {
  it('names the default continuation after the parent', () => {
    expect(defaultChildPrompt('Refactor')).toBe('Continue from where Refactor left off.')
  })

  it('composes the header line behind a final prompt', () => {
    const preview = chainPreview('Refactor', 'go on', 'summarize')
    expect(preview).toBe(
      `Prior session last message:\n…the final prompt\u2019s answer rides here once it finishes…\n\n----\n\ngo on`,
    )
  })

  it('runs the prompt alone without a final prompt', () => {
    expect(chainPreview('Refactor', 'go on', '')).toBe('go on')
    expect(chainPreview('Refactor', '', '')).toBe('Continue from where Refactor left off.')
  })

  it('substitutes the default continuation visibly', () => {
    const preview = chainPreview('Refactor', '', 'summarize')
    expect(preview.endsWith('\n\n----\n\nContinue from where Refactor left off.')).toBe(true)
  })
})

describe('useChainForm', () => {
  const bodies: { url: string; body?: string }[] = []

  beforeEach(() => {
    bodies.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const path = String(url).split('?')[0]
        bodies.push({ url: path, body: init?.body ? String(init.body) : undefined })
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions')
          return Response.json([
            { sessionId: PARENT, name: 'source', state: 'online' },
            { sessionId: CHILD, name: 'target', state: 'online' },
          ])
        if (path === '/api/attention') return Response.json([])
        if (path === `/api/sessions/${PARENT}/entries`)
          return Response.json({
            entries: [
              {
                id: '01A1',
                type: 'message',
                data: {
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', data: { text: 'old answer' } }],
                  },
                },
              },
            ],
          })
        if (path === `/api/sessions/${PARENT}/chain`)
          return Response.json(
            { id: 'chn_1', parentId: PARENT, childId: CHILD, childPrompt: 'x', state: 'waiting' },
            { status: 201 },
          )
        if (path === '/api/chains/chn_9') return Response.json({ ok: true })
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mount(draft: { parentId: string; childId: string; chain?: Chain } | null) {
    const onDone = vi.fn()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <AuthProvider>
          <SwarmProvider>
            <WorkspaceProvider>{children}</WorkspaceProvider>
          </SwarmProvider>
        </AuthProvider>
      </MemoryRouter>
    )
    const form = renderHook((next: typeof draft = draft) => useChainForm(next, onDone), {
      wrapper,
    })
    return { form, onDone }
  }

  it('previews the future answer and resets per draft', async () => {
    const { form } = mount({ parentId: PARENT, childId: CHILD })
    // the final prompt's answer is future work, the parent's latest response
    // never previews as the handoff
    act(() => form.result.current.setFinalPrompt('summarize'))
    expect(form.result.current.preview).toContain(
      'the final prompt’s answer rides here once it finishes',
    )
    expect(form.result.current.preview).not.toContain('old answer')
    await waitFor(() => {
      expect(form.result.current.parentName).toBe('source')
    })
    expect(form.result.current.dirty).toBe(true)

    act(() => form.result.current.setChildPrompt('typed'))
    expect(form.result.current.dirty).toBe(true)
    expect(form.result.current.effectivePrompt).toBe('typed')

    // a fresh draft resets the fields
    form.rerender({ parentId: CHILD, childId: PARENT })
    await waitFor(() => {
      expect(form.result.current.childPrompt).toBe('')
    })
    expect(form.result.current.effectivePrompt).toBe('Continue from where target left off.')
  })

  it('submits the effective prompt and prefills edits', async () => {
    const existing: Chain = {
      id: 'chn_9',
      parentId: PARENT,
      childId: CHILD,
      finalPrompt: 'wrap up',
      childPrompt: 'first draft',
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1,
    }
    const { form, onDone } = mount({ parentId: PARENT, childId: CHILD, chain: existing })
    await waitFor(() => {
      expect(form.result.current.childPrompt).toBe('first draft')
    })
    expect(form.result.current.editing).toBe(true)
    expect(form.result.current.dirty).toBe(false)

    let done: Promise<void> = Promise.resolve()
    await act(async () => {
      done = form.result.current.submit()
      await done
    })
    expect(onDone).toHaveBeenCalledTimes(1)
    const patch = bodies.find((b) => b.url === '/api/chains/chn_9')
    expect(patch?.body).toContain('"childPrompt":"first draft"')
  })

  it('sends the default line when the prompt stays empty', async () => {
    const { form, onDone } = mount({ parentId: PARENT, childId: CHILD })
    await waitFor(() => {
      expect(form.result.current.parentName).toBe('source')
    })
    await act(async () => {
      await form.result.current.submit()
    })
    expect(onDone).toHaveBeenCalledTimes(1)
    const create = bodies.find((b) => b.url === `/api/sessions/${PARENT}/chain`)
    expect(create).toBeDefined()
    expect(JSON.parse(create!.body!)).toMatchObject({
      childId: CHILD,
      childPrompt: 'Continue from where source left off.',
    })
  })

  it('keeps a running final prompt immutable on edit', async () => {
    const existing: Chain = {
      id: 'chn_9',
      parentId: PARENT,
      childId: CHILD,
      finalPrompt: 'wrap up',
      childPrompt: 'first draft',
      state: 'final',
      createdAt: 1,
      updatedAt: 1,
    }
    const { form } = mount({ parentId: PARENT, childId: CHILD, chain: existing })
    await waitFor(() => {
      expect(form.result.current.finalRunning).toBe(true)
    })
    expect(form.result.current.finalPrompt).toBe('wrap up')

    act(() => form.result.current.setChildPrompt('edited'))
    await act(async () => {
      await form.result.current.submit()
    })
    const patch = bodies.find((b) => b.url === '/api/chains/chn_9')
    expect(JSON.parse(patch!.body!)).toMatchObject({
      finalPrompt: 'wrap up',
      childPrompt: 'edited',
    })
  })
})
