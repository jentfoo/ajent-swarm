import { describe, expect, it } from 'vitest'

import { deriveBlocks, maxRecallPrompts, mergeRecallSources, recallPrompts } from './derive'
import type { DerivedBlock, RecallPrompt, ToolCallInfo } from './derive'
import type { Entry } from '../api/types'

// Fixtures transcribed from ajent's docs/control-api.md entry shapes, the
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

// injectedEntry builds a replay-marked context message, the shape InjectBlock
// paints.
function injectedEntry(id: string, text: string): Entry {
  return messageEntry(id, undefined, 'user', [textBlock(text)], {
    injected: true,
    replayed: true,
  })
}

// callPartsOf flattens an assistant block's calls, text parts stay inline.
function callPartsOf(block: DerivedBlock): ToolCallInfo[] {
  if (block.kind !== 'assistant') return []
  return block.parts.flatMap((p) => (p.kind === 'call' ? [p.call] : []))
}

describe('deriveBlocks user classification', () => {
  it('separates user turns from tool-result carriers and injected context', () => {
    const user = messageEntry('01P', undefined, 'user', [textBlock('fix the bug')])
    const carrier = messageEntry('01C', '01P', 'user', [
      { type: 'tool_result', data: { callId: 'c1', content: [] } },
    ])
    const injected = injectedEntry('01I', 'system context')
    injected.parentId = '01C'

    const [p, c, i] = blocks([user, carrier, injected])
    expect(p).toMatchObject({ kind: 'user', id: '01P', text: 'fix the bug' })
    // a carrier with no call to fold under renders its results standalone
    expect(c).toMatchObject({ kind: 'tool-results', id: '01C' })
    expect(i).toMatchObject({
      kind: 'injected',
      id: '01I',
      replayed: true,
      shellRun: false,
      label: 'system context',
      body: '',
    })
  })

  it('cuts an injected label from its body', () => {
    const out = blocks([injectedEntry('01I', 'User Ran: make test\n\none\ntwo')])
    expect(out).toEqual([
      {
        kind: 'injected',
        id: '01I',
        replayed: true,
        shellRun: true,
        label: 'User Ran: make test',
        body: 'one\ntwo',
      },
    ])
  })

  it('marks only a shell flush as a shell run', () => {
    // the User Ran marker must be the label's own prefix, not body text
    const flush = blocks([injectedEntry('01S', 'User Ran: ls\n\nOutput:\nuser ran: ls')])
    const plan = blocks([injectedEntry('01P', 'Plan\n\nstep one')])
    expect(flush[0]).toMatchObject({ shellRun: true, label: 'User Ran: ls' })
    expect(plan[0]).toMatchObject({ shellRun: false, label: 'Plan' })
  })

  it('keeps injected body shape past the label gap', () => {
    // only the blank lines separating label from body collapse, interior blank
    // lines and indentation are the record itself
    const out = blocks([injectedEntry('01I', 'User Ran: cat f\n\n  indented\n\nplain')])
    expect(out[0]).toMatchObject({ label: 'User Ran: cat f', body: '  indented\n\nplain' })
  })

  it('drops injected context with a blank label', () => {
    const out = blocks([
      injectedEntry('01E', ''),
      injectedEntry('01N', '\nhidden'),
      injectedEntry('01W', '   \t\nalso hidden'),
    ])
    expect(out).toEqual([])
  })

  it('renders nothing for injected context without a replay mark', () => {
    const entry = messageEntry('01I', undefined, 'user', [textBlock('hidden')], { injected: true })
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
    // only the retired call renders, the live card covers it until handoff
    expect(callPartsOf(out[0]).map((c) => c.id)).toEqual(['done1'])
  })

  it('stamps permit verdicts onto their committed calls', () => {
    const assistant = messageEntry('01A', undefined, 'assistant', [
      { type: 'tool_call', data: { id: 'c1', name: 'bash' } },
    ])

    // the map rides the applier state, derivation only looks up by call id
    const verdicts = new Map([
      ['c1', 'auto allowed'],
      ['c9', 'never attached'],
    ])
    const map = new Map([assistant].map((e) => [e.id, e]))
    const out = deriveBlocks(['01A'], map, undefined, verdicts)
    expect(callPartsOf(out[0])).toEqual([{ id: 'c1', name: 'bash', verdict: 'auto allowed' }])

    // no verdicts captured: cards render exactly as before
    const bare = deriveBlocks(['01A'], map)
    expect(callPartsOf(bare[0])).toEqual([{ id: 'c1', name: 'bash' }])
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
    // file order arrives reversed here, the chain ids dictate rendering order
    const out = blocks([reply, root], undefined, ['01ROOT', '01REPLY'])
    expect(out.map((b) => b.kind)).toEqual(['user', 'assistant'])
  })
})

describe('recallPrompts', () => {
  it('lists typed prompts newest first and deduplicated', () => {
    const entries: Entry[] = [
      messageEntry('01P1', undefined, 'user', [textBlock('first idea')]),
      messageEntry('01A1', '01P1', 'assistant', [textBlock('done')]),
      messageEntry('01P2', '01A1', 'user', [textBlock('second idea')]),
      messageEntry('01P3', '01P2', 'user', [textBlock('first idea')]), // repeat
    ]
    const map = new Map(entries.map((e) => [e.id, e]))
    expect(recallPrompts(['01P1', '01A1', '01P2', '01P3'], map)).toEqual([
      { text: 'first idea', ts: 1730000000000 }, // the newest occurrence wins
      { text: 'second idea', ts: 1730000000000 },
    ])
  })

  it('excludes injected context and tool-result carriers', () => {
    const entries: Entry[] = [
      messageEntry('01P', undefined, 'user', [textBlock('typed')]),
      injectedEntry('01I', 'system context'),
      messageEntry('01C', '01P', 'user', [
        { type: 'tool_result', data: { callId: 'c1', content: [] } },
      ]),
    ]
    const map = new Map(entries.map((e) => [e.id, e]))
    expect(recallPrompts(['01P', '01I', '01C'], map)).toEqual([
      { text: 'typed', ts: 1730000000000 },
    ])
  })

  it('drops empty texts and keeps the newest 500 prompts', () => {
    const imageOnly = messageEntry('01IMG', undefined, 'user', [
      { type: 'image', data: { mediaType: 'image/png' } },
    ])
    const entries: Entry[] = [imageOnly]
    const ids: string[] = ['01IMG']
    for (let i = 0; i < 505; i++) {
      const id = `01F${String(i).padStart(4, '0')}`
      entries.push(messageEntry(id, undefined, 'user', [textBlock(`prompt ${i}`)]))
      ids.push(id)
    }
    const map = new Map(entries.map((e) => [e.id, e]))
    const out = recallPrompts(ids, map)
    expect(out).toHaveLength(500)
    expect(out[0]).toEqual({ text: 'prompt 504', ts: 1730000000000 }) // newest first
    expect(out.map((p) => p.text)).not.toContain('')
  })
})

describe('mergeRecallSources', () => {
  const at = (ms: number): RecallPrompt => ({ text: `t${ms}`, ts: ms })

  it('interleaves under one newest-first order', () => {
    const local = [at(100), at(300)]
    const workspace = [at(400), at(200)]
    expect(mergeRecallSources(local, workspace)).toEqual(['t400', 't300', 't200', 't100'])
  })

  it('keeps each text once at its newest occurrence', () => {
    const local = [{ text: 'shared', ts: 100 }, at(500)]
    const workspace = [{ text: 'shared', ts: 900 }]
    // 'shared' sits at its newest position and the older copy drops out
    expect(mergeRecallSources(local, workspace)).toEqual(['shared', 't500'])
  })

  it('drops empty texts and caps at the shared bound', () => {
    const workspace: RecallPrompt[] = [{ text: '', ts: 999 }]
    for (let i = 0; i < maxRecallPrompts + 20; i++) workspace.push({ text: `w${i}`, ts: i })
    const out = mergeRecallSources([], workspace)
    expect(out).toHaveLength(maxRecallPrompts)
    expect(out[0]).toBe(`w${maxRecallPrompts + 19}`)
  })

  it('ties keep their source order', () => {
    const local = [{ text: 'local', ts: 5 }]
    const workspace = [{ text: 'mirror', ts: 5 }]
    expect(mergeRecallSources(local, workspace)).toEqual(['local', 'mirror'])
  })
})
