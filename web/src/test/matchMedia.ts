import { vi } from 'vitest'

import { mobileLayout } from '../hooks/useMediaQuery'

// stubCoarsePointer reports a touch-primary device: only the coarse-pointer
// query matches, and the stand-in carries the listener surface useMediaQuery
// subscribes through.
export function stubCoarsePointer(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
  }))
}

// coarseImport re-imports a module with matchMedia reporting a touch-primary
// device: module-scope gates read the stub only through a fresh import.
export async function coarseImport<T>(load: () => Promise<T>): Promise<T> {
  stubCoarsePointer()
  vi.resetModules()
  return load()
}

// stubPhoneLayout reports only the shared 48rem breakpoint as matching, so
// breakpoint-switched screens mount their card presentation, everything else
// stays desktop.
export function stubPhoneLayout(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === mobileLayout,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
  }))
}
