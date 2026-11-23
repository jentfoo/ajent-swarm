import { describe, expect, it } from 'vitest'

import { matchesQuery, normalizeQuery } from './textMatch'

// The shared rule every operational list filter agrees on: case-insensitive
// substring across the row's facts, a whitespace-only query reading as none.
describe('normalizeQuery', () => {
  it('trims and lowercases the box value', () => {
    expect(normalizeQuery('  Foo Bar  ')).toBe('foo bar')
  })

  it('reads whitespace only as empty', () => {
    expect(normalizeQuery('   ')).toBe('')
    expect(normalizeQuery('\t\n')).toBe('')
  })
})

describe('matchesQuery', () => {
  it('matches any candidate field case-insensitively', () => {
    expect(matchesQuery('repo', '/home/you/Repo')).toBe(true)
    expect(matchesQuery('repo', 'nightly sweep')).toBe(false)
    expect(matchesQuery('sweep', undefined, 'nightly sweep')).toBe(true)
  })

  it('matches everything on an empty query', () => {
    expect(matchesQuery('', 'x')).toBe(true)
    expect(matchesQuery('', undefined)).toBe(true)
  })

  it('skips undefined candidates without failing the row', () => {
    expect(matchesQuery('repo', undefined, undefined)).toBe(false)
  })
})
