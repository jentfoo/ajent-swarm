import { describe, expect, it } from 'vitest'

import { classifyLine } from './lineKind'
import type { LineKind } from './lineKind'

// The composer's mirror of ajent's ParseLine (ajent/pkg/command/parse_test.go),
// held to the same table so the two classifications cannot drift.

describe('classifyLine', () => {
  it.each<[string, string, LineKind]>([
    ['plain prompt', 'hello world', 'prompt'],
    ['slash command', '/model', 'command'],
    ['slash with args', '/model gpt', 'command'],
    ['double slash escape', '//literal', 'prompt'],
    ['leading space escapes', ' /notacommand', 'prompt'],
    ['shell stages', '!go test ./...', 'shell'],
    ['double bang excludes', '!!echo hi', 'shell-excluded'],
    ['triple bang excludes', '!!!echo hi', 'shell-excluded'],
    ['leading space literal bang', ' !echo hi', 'prompt'],
    ['bare slash', '/', 'command'],
    ['empty prompt', '', 'prompt'],
    ['at refs prompt', '@main.go and @b.go', 'prompt'],
    ['email prompt', 'email@example.com', 'prompt'],
    ['multiline plain prompt', 'line one\nline two', 'prompt'],
    ['multiline slash paste', '/etc/hosts is stale\nfix it', 'prompt'],
    ['multiline shell stages', '!ls\npwd', 'shell'],
    ['multiline double bang stages', '!!echo hi\nbye', 'shell-excluded'],
    ['multiline double slash escape', '//literal\nmore', 'prompt'],
  ])('%s', (_name, line, kind) => {
    expect(classifyLine(line)).toBe(kind)
  })
})
