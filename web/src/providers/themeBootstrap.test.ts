import indexHtml from '../../index.html?raw'
import providerSrc from './swarm.tsx?raw'
import { afterEach, describe, expect, it, vi } from 'vitest'

// index.html's head script applies the stored theme before first paint; these
// tests pin its decision rules to SwarmProvider's readStored/preferredTheme so
// the two cannot drift apart.

const bootstrapScript = (): string =>
  /<script id="theme-bootstrap">([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? ''

// Evaluates the head script against jsdom's globals, returning what it applied.
function runBootstrap(): string | undefined {
  const script = bootstrapScript()
  expect(script).toBeTruthy() // guard against a silently renamed tag
  new Function(script)()
  return document.documentElement.dataset.theme
}

// jsdom ships no matchMedia; tests that exercise the scheme fallback stub it.
function stubScheme(prefersLight: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: prefersLight && query.includes('light'),
  }))
}

describe('theme bootstrap script', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
    delete document.documentElement.dataset.theme
  })

  it('stored light wins over dark system', () => {
    stubScheme(false)
    localStorage.setItem('swarm.theme', 'light')
    expect(runBootstrap()).toBe('light')
  })

  it('stored dark wins over light system', () => {
    stubScheme(true)
    localStorage.setItem('swarm.theme', 'dark')
    expect(runBootstrap()).toBe('dark')
  })

  it('invalid stored value falls back to scheme', () => {
    stubScheme(true)
    localStorage.setItem('swarm.theme', 'system')
    expect(runBootstrap()).toBe('light')
  })

  it('missing storage follows system preference', () => {
    stubScheme(false)
    expect(runBootstrap()).toBe('dark')
  })

  it('no match media defaults to dark', () => {
    expect(runBootstrap()).toBe('dark')
  })

  it('storage failure falls back to scheme', () => {
    stubScheme(true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied')
    })
    expect(runBootstrap()).toBe('light')
  })

  it('bootstrap and provider share the storage key', () => {
    const KEY = "'swarm.theme'"
    expect(indexHtml).toContain(KEY)
    expect(providerSrc).toContain(KEY)
  })
})
