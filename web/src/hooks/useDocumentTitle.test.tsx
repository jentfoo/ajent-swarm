import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { composeTitle, useDocumentTitle } from './useDocumentTitle'
import type { AttentionRow } from '../api/types'
import { AuthProvider } from '../providers/auth'
import { SwarmProvider, useSwarm } from '../providers/swarm'
import { WorkspaceProvider } from '../providers/workspace'

// The one document.title composition: a gated needs-input count prefix and the
// route's label over the product name. The hook tests ride the real provider
// stack, moving the count the way a fresh attention digest does.

describe('composeTitle', () => {
  it.each([
    ['bare product name', '', 0, 'ajent-swarm'],
    ['label only', 'Sessions', 0, 'Sessions · ajent-swarm'],
    ['count only', '', 2, '(2) ajent-swarm'],
    ['session label with a count', 'Refactor parser', 2, '(2) Refactor parser · ajent-swarm'],
  ])('composes %s', (_name, label, count, expected) => {
    expect(composeTitle(label, count)).toBe(expected)
  })
})

let attention: AttentionRow[]
let refreshDigest: () => Promise<void> = () => Promise.resolve()

// TitleHarness renders the hook under the providers and hands the digest
// refresh over, so a test can move the count like a fresh poll does.
function TitleHarness({ label }: { label: string }) {
  const { refreshAttention } = useSwarm()
  useEffect(() => {
    refreshDigest = refreshAttention
  }, [refreshAttention])
  useDocumentTitle(label)
  return null
}

function fullTree(label: string) {
  return (
    <MemoryRouter>
      <AuthProvider>
        <SwarmProvider>
          <WorkspaceProvider>
            <TitleHarness label={label} />
          </WorkspaceProvider>
        </SwarmProvider>
      </AuthProvider>
    </MemoryRouter>
  )
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    attention = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url).split('?')[0]
        if (path === '/api/me') return Response.json({ username: 'you', via: 'cookie' })
        if (path === '/api/sessions') return Response.json([])
        if (path === '/api/attention') return Response.json(attention)
        if (path === '/api/chains') return Response.json([])
        throw new Error(`unexpected fetch ${path}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // long enough ago that the notice dwell has passed
  function dialogRow(sessionId: string, dialogId: number): AttentionRow {
    return {
      sessionId,
      openInteractions: 1,
      running: false,
      idle: true,
      kind: 'needs-input',
      reason: 'allow write?',
      dialogId,
      since: Date.now() - 10_000,
    }
  }

  it('follows label changes and count changes', async () => {
    const view = render(fullTree(''))
    expect(document.title).toBe('ajent-swarm')

    view.rerender(fullTree('Sessions'))
    expect(document.title).toBe('Sessions · ajent-swarm')

    // a digest carrying two dwell-gated dialogs raises the count prefix
    attention = [dialogRow('s1', 3), dialogRow('s2', 7)]
    await act(async () => {
      await refreshDigest()
    })
    expect(document.title).toBe('(2) Sessions · ajent-swarm')

    // both settle on a later digest and the prefix drops with them
    attention = []
    await act(async () => {
      await refreshDigest()
    })
    expect(document.title).toBe('Sessions · ajent-swarm')
  })

  it('keeps dwell-gated dialogs out of the count', async () => {
    attention = [{ ...dialogRow('s1', 3), since: Date.now() - 1_000 }]
    render(fullTree('Sessions'))

    expect(document.title).toBe('Sessions · ajent-swarm')
  })
})

// Node's fs reads the sources under every vitest environment; the web tsconfig
// types only the DOM, so this single probe steps outside it deliberately.
// @ts-expect-error node builtins stay untyped in the web project on purpose
const fs = (await import('node:fs')) as {
  readdirSync(path: string, options: { recursive: boolean; encoding: string }): string[]
  readFileSync(path: string, encoding: string): string
}

// Every route surface calls the hook exactly once: a route that forgets it
// leaves whatever title the previous screen wrote in place.
const titleSurfaces = [
  'src/screens/SessionsHome.tsx',
  'src/screens/JobsHome.tsx',
  'src/screens/RunsHistory.tsx',
  'src/screens/SessionView.tsx',
  'src/screens/WorkspaceRoute.tsx',
  'src/screens/LoginScreen.tsx',
  'src/screens/BootstrapScreen.tsx',
  'src/mobile/MobileHome.tsx',
  'src/mobile/MobileSessionScreen.tsx',
  'src/mobile/EndedSessionScreen.tsx',
]

describe('route title checklist', () => {
  it.each(titleSurfaces)('titles %s exactly once', (file) => {
    const calls = fs.readFileSync(file, 'utf8').match(/useDocumentTitle\(/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('keeps document.title writes in the hook alone', () => {
    // recursive listing returns paths without the base dir on direct children
    const sources = fs
      .readdirSync('src', { recursive: true, encoding: 'utf8' })
      .map((f) => `src/${f}`)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.'))
      .filter((f) => f !== 'src/hooks/useDocumentTitle.ts')
    for (const file of sources) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain('document.title')
    }
  })
})
