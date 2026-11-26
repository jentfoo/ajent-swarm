import { describe, expect, it } from 'vitest'

import { prettyInput, unquoteJSON } from './toolInput'

describe('unquoteJSON', () => {
  it.each([
    { name: 'double-encoded object', value: '{"path":"a.go"}', want: { path: 'a.go' } },
    { name: 'double-encoded array', value: '[{"oldText":"a"}]', want: [{ oldText: 'a' }] },
    { name: 'quoted string', value: '"ls"', want: 'ls' },
    { name: 'plain text stays a string', value: 'ls -la', want: 'ls -la' },
    { name: 'broken json stays a string', value: '{"path":', want: '{"path":' },
    { name: 'objects pass through', value: { path: 'a.go' }, want: { path: 'a.go' } },
    { name: 'undefined passes through', value: undefined, want: undefined },
    { name: 'null passes through', value: null, want: null },
  ])('$name', ({ value, want }) => {
    expect(unquoteJSON(value)).toEqual(want)
  })
})

describe('prettyInput', () => {
  it.each([
    { name: 'strings verbatim', input: 'go test ./...', want: 'go test ./...' },
    { name: 'objects two-space indented', input: { cmd: 'ls' }, want: '{\n  "cmd": "ls"\n}' },
    { name: 'arrays two-space indented', input: ['a', 1], want: '[\n  "a",\n  1\n]' },
    { name: 'numbers stringify', input: 42, want: '42' },
    { name: 'undefined degrades to String', input: undefined, want: 'undefined' },
  ])('$name', ({ input, want }) => {
    expect(prettyInput(input)).toBe(want)
  })

  it('degrades a cyclic value to String', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(prettyInput(cyclic)).toBe('[object Object]')
  })
})
