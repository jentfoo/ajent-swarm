import { describe, expect, it } from 'vitest'

import { atTokenBefore } from './atCompletion'

describe('atTokenBefore', () => {
  const cases: { name: string; text: number | string; caret?: number; want: unknown }[] = [
    { name: 'no token without @', text: 'fix the bug', want: null },
    {
      name: 'token opens at line start',
      text: '@src/ma',
      caret: 7,
      want: { start: 0, query: 'src/ma' },
    },
    {
      name: 'token opens after whitespace',
      text: 'see @pkg/mod',
      caret: 12,
      want: { start: 4, query: 'pkg/mod' },
    },
    { name: 'mid-word @ is prose', text: 'email me@home', caret: 13, want: null },
    {
      name: 'query stops at the caret',
      text: '@src/main.rs extra',
      caret: 12,
      want: { start: 0, query: 'src/main.rs' },
    },
    { name: 'whitespace in the token closes it', text: '@src main', caret: 9, want: null },
    { name: 'bare @ completes everything', text: '@', caret: 1, want: { start: 0, query: '' } },
  ] as const

  for (const tc of cases) {
    it(tc.name, () => {
      expect(atTokenBefore(tc.text as string, tc.caret ?? (tc.text as string).length)).toEqual(
        tc.want,
      )
    })
  }
})
