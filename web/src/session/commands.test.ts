import { describe, expect, it } from 'vitest'

import { commandDocs, matchCommands, slashQuery } from './commands'
describe('slashQuery', () => {
  const cases: { name: string; text: string; caret?: number; want: string | null }[] = [
    { name: 'line initial slash queries', text: '/model', want: 'model' },
    { name: 'bare slash lists everything', text: '/', want: '' },
    { name: 'query stops at the caret', text: '/model rest', caret: 3, want: 'mo' },
    { name: 'leading space stays a prompt', text: ' /model', want: null },
    { name: 'mid-line slash is prose', text: 'see /model', want: null },
    { name: 'whitespace closes the token', text: '/model x', want: null },
    { name: 'caret at line start offers nothing', text: '/model', caret: 0, want: null },
    { name: 'the escape form queries a slash', text: '//literal', want: '/literal' },
    { name: 'caret past a newline stays closed', text: '/a\nb', want: null },
    { name: 'caret before the newline still queries', text: '/a\nb', caret: 2, want: 'a' },
    { name: 'caret beyond the text clamps', text: '/mo', caret: 99, want: 'mo' },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      expect(slashQuery(tc.text, tc.caret ?? tc.text.length)).toBe(tc.want)
    })
  }
})

describe('matchCommands', () => {
  it('empty query lists the table in order', () => {
    expect(matchCommands('')).toEqual(commandDocs)
  })

  it('prefix matches keep table order', () => {
    expect(matchCommands('pl').map((c) => c.name)).toEqual(['plan', 'plan-stop', 'plan-status'])
  })

  it('substring matches follow prefix matches', () => {
    expect(matchCommands('s').map((c) => c.name)).toEqual([
      'session',
      'settings',
      'reasoning',
      'usage',
      'tools',
      'agents',
      'plan-stop',
      'plan-status',
    ])
  })

  it('matches case-insensitively', () => {
    expect(matchCommands('MOD').map((c) => c.name)).toEqual(['model'])
  })

  it('unknown and escaped queries match nothing', () => {
    expect(matchCommands('zzz')).toEqual([])
    expect(matchCommands('/help')).toEqual([])
  })
})
