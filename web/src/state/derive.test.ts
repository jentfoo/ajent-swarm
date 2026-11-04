import { describe, expect, it } from 'vitest'

import { deriveBlocks } from './derive'
import type { DerivedBlock, ToolCallInfo } from './derive'
import type { Entry } from '../api/types'

// Fixtures transcribed from ajent's docs/control-api.md entry shapes; the
// classification mirrors pkg/session/replay.go's shared echo rule.

function blocks(entries: Entry[], hide?: Set<string>, order?: string[]) {
  const map = new Map(entries.map((e) => [e.id, e]))
  return deriveBlocks(order ?? entries.map((e) => e.id), map, hide)
}

const textBlock = (text: string) => ({ type: 'text', data: { text } })
const thinkBlock = (text: string) => ({ type: 'thinking', data: { text } })

function messageEntry(
  id: string,
  parentId: string | undefined,
  role: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
) {
  const e: Entry = {
    id,
    type: 'message',
    ts: 1730000000000,
    data: JSON.parse(JSON.stringify({ message: { role, content }, ...extra })),
  }
  if (parentId !== undefined) e.parentId = parentId
  return e
}

// callPartsOf flattens an assistant block's calls; text parts stay inline.
function callPartsOf(block: DerivedBlock): ToolCallInfo[] {
  if (block.kind !== 'assistant') return []
  return block.parts.flatMap((p) => (p.kind === 'call' ? [p.call] : []))
}

describe('deriveBlocks user classification', () => {
  it('separates prompts from tool-result carriers and injected context', () => {
    const prompt = messageEntry('01P', undefined, 'user', [textBlock('fix the bug')])
    const carrier = messageEntry('01C', '01P', 'user', [
      { type: 'tool_result', data: { callId: 'c1', content: [] } },
    ])
    const injected = {
      ...messageEntry('01I', '01C', 'user', [textBlock('system context')]),
      data: JSON.parse(
        JSON.stringify({
          message: { role: 'user', content: [{ type: 'text', data: { text: 'system context' } }] },
          injected: true,
          replayed: true,
        }),
      ),
    }

    const [p, c, i] = blocks([prompt, carrier, injected])
    expect(p).toMatchObject({ kind: 'prompt', id: '01P', text: 'fix the bug' })
    // a carrier with no call to fold under renders its results standalone
    expect(c).toMatchObject({ kind: 'tool-results', id: '01C' })
    expect(i).toMatchObject({ kind: 'injected', id: '01I', replayed: true, text: 'system context' })
  })

  it('renders nothing for injected context without a replay mark', () => {
    const entry = messageEntry('01I', undefined, 'user', [textBlock('hidden')])
    entry.data = JSON.parse(
      JSON.stringify({
        message: { role: 'user', content: [{ type: 'text', data: { text: 'hidden' } }] },
        injected: true,
      }),
    )
    expect(blocks([entry])).toEqual([])
  })

  it('keeps a carrier silent when every result folds under its call', () => {
    const assistant = messageEntry('01A', undefined, 'assistant', [
      thinkBlock('hmm'),
      { type: 'tool_call', data: { id: 'c1', name: 'read_file' } },
    ])
    const carrier = messageEntry('01C', '01A', 'user', [
      {
        type: 'tool_result',
        data: {
          callId: 'c1',
          content: [textBlock('file body')],
          isError: true,
          toolName: 'read_file',
        },
      },
    ])

    const out = blocks([assistant, carrier])
    expect(out).toHaveLength(1)
    const block = out[0]
    expect(block.kind).toBe('assistant')
    if (block.kind !== 'assistant') return
    expect(block.thinking).toEqual(['hmm'])
    const calls = callPartsOf(block)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.result).toMatchObject({
      callId: 'c1',
      text: 'file body',
      isError: true,
      toolName: 'read_file',
    })
  })

  it('renders display text when the result carries one', () => {
    const assistant = messageEntry('01A', undefined, 'assistant', [
      { type: 'tool_call', data: { id: 'c1', name: 'bash' } },
    ])
    const carrier = messageEntry('01C', '01A', 'user', [
      {
        type: 'tool_result',
        data: { callId: 'c1', content: [textBlock('model body')], display: 'screen body' },
      },
    ])
    const out = blocks([assistant, carrier]) as Extract<
      ReturnType<typeof deriveBlocks>[number],
      { kind: 'assistant' }
    >[]
    expect(callPartsOf(out[0])[0]?.result?.text).toBe('screen body')
  })
})

describe('deriveBlocks assistant shape', () => {
  it('keeps text, calls and thinking in content order', () => {
    const entry = messageEntry(
      '01A',
      undefined,
      'assistant',
      [
        thinkBlock('reasoning'),
        textBlock('first'),
        { type: 'tool_call', data: { id: 'c9', name: 'edit', input: { path: '/x' } } },
        textBlock('second'),
      ],
      { stop: 'tool_use' },
    )

    const [block] = blocks([entry])
    expect(block).toMatchObject({ kind: 'assistant', stop: 'tool_use' })
    if (block.kind !== 'assistant') return
    // parts preserve the wire's content order: text, call, then the closing text
    expect(block.parts).toEqual([
      { kind: 'text', text: 'first' },
      { kind: 'call', call: { id: 'c9', name: 'edit', input: { path: '/x' } } },
      { kind: 'text', text: 'second' },
    ])
    expect(block.thinking).toEqual(['reasoning'])
  })

  it('hides calls still painting live but keeps them folded for results', () => {
    const assistant = messageEntry('01A', undefined, 'assistant', [
      { type: 'tool_call', data: { id: 'live1', name: 'bash' } },
      { type: 'tool_call', data: { id: 'done1', name: 'read_file' } },
    ])
    const carrier = messageEntry('01C', '01A', 'user', [
      { type: 'tool_result', data: { callId: 'done1', content: [] } },
    ])

    const out = blocks([assistant, carrier], new Set(['live1']))
    expect(out[0]).toMatchObject({ kind: 'assistant' })
    if (out[0].kind !== 'assistant') return
    // only the retired call renders; the live card covers it until handoff
    expect(callPartsOf(out[0]).map((c) => c.id)).toEqual(['done1'])
  })
})

describe('deriveBlocks non-message entries', () => {
  it('renders compaction as a divider and notices level-tinted', () => {
    const out = blocks([
      { id: '01X', type: 'compaction', ts: 1, data: JSON.parse('{}') },
      {
        id: '01N',
        type: 'notice',
        ts: 2,
        data: JSON.parse('{"message":"careful","level":"warn"}'),
      },
    ])
    expect(out[0]).toMatchObject({ kind: 'compaction' })
    expect(out[1]).toMatchObject({ kind: 'notice', level: 'warn', text: 'careful' })
  })

  it('renders system chips and unknown types generically', () => {
    const out = blocks([
      { id: '01M', type: 'model_change', ts: 1, data: JSON.parse('{"model":"gpt"}') },
      { id: '01U', type: 'brand_new_type', ts: 2, data: JSON.parse('{}') },
    ])
    expect(out[0]).toMatchObject({ kind: 'system' })
    expect(out[1]).toMatchObject({ kind: 'unknown', type: 'brand_new_type' })
  })

  it('walks the chain order it is given, not the entry map', () => {
    const root = messageEntry('01ROOT', undefined, 'user', [textBlock('root')])
    const reply = messageEntry('01REPLY', '01ROOT', 'assistant', [textBlock('reply')])
    // file order arrives reversed here; the chain ids dictate rendering order
    const out = blocks([reply, root], undefined, ['01ROOT', '01REPLY'])
    expect(out.map((b) => b.kind)).toEqual(['prompt', 'assistant'])
  })
})
