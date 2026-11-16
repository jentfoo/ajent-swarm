import { describe, expect, it } from 'vitest'

import { progressText } from './progressText'

// Pins the compose-progress text against upstream's TUI activity row tail:
// "132 lines · 4.1kb", binary units with a trailing .0 dropped.

describe('progressText', () => {
  it('counts lines beside size', () => {
    expect(progressText({ path: 'notes.go', lines: 132, bytes: 4203 })).toBe('132 lines · 4.1kb')
  })

  it('drops zero line count', () => {
    expect(progressText({ bytes: 300 })).toBe('300b')
  })

  it('renders nothing without content', () => {
    expect(progressText({})).toBe('')
    expect(progressText({ path: 'a.go' })).toBe('')
  })

  it('abbreviates binary byte sizes', () => {
    const size = (bytes: number): string => progressText({ bytes })
    expect(size(259)).toBe('259b')
    expect(size(1024)).toBe('1kb')
    expect(size(2048)).toBe('2kb')
    expect(size(3584)).toBe('3.5kb')
    // a half-step below 1mb rounds up, so nothing renders as "1024kb"
    expect(size(1024 * 1024 - 26)).toBe('1mb')
    expect(size(1024 * 1024)).toBe('1mb')
  })
})
