import { vi } from 'vitest'

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
