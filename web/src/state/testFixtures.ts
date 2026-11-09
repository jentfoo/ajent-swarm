// Test builders for wire shapes, with example payloads transcribed from
// ajent's docs/control-api.md.
import type { CtlState, Entry, InitFrame, WireEvent } from '../api/types'

export function testState(overrides: Partial<CtlState> = {}): CtlState {
  return {
    session: { id: '01TESTSESSION0000' },
    workspace: '/home/you/project',
    cwd: '/home/you/project',
    head: '',
    model: {
      key: 'anthropic/claude-sonnet',
      short: 'sonnet',
      window: 200_000,
      caps: { reasoning: true, images: true, parallelToolCalls: true },
    },
    permission: '',
    tools: [],
    usage: { turns: 0, total: zero(), child: zero(), estimatedTurns: 0 },
    context: { used: 1000, window: 200_000, reserve: 20_000, compact: 150_000, estimated: false },
    running: false,
    idle: true,
    spinning: false,
    queued: 0,
    queuedRows: [],
    activity: [],
    status: { segments: [] },
    seat: { held: false, yours: false },
    ...overrides,
  }
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

export function entry(
  id: string,
  parentId: string | undefined,
  type: string,
  data?: unknown,
): Entry {
  const e: Entry = { id, type, ts: 1730000000000 }
  if (parentId !== undefined) e.parentId = parentId
  if (data !== undefined) e.data = data
  return e
}

export function messageEntry(
  id: string,
  parent: string | undefined,
  role: string,
  text: string,
): Entry {
  return entry(
    id,
    parent,
    'message',
    JSON.parse(
      `{"message":{"role":"${role}","content":[{"type":"text","data":{"text":${JSON.stringify(text)}}}]}}`,
    ),
  )
}

export function initFrame(state: CtlState, entries: Entry[], cursor?: string): InitFrame {
  const frame: InitFrame = { type: 'init', sessionId: state.session.id, state, entries }
  if (cursor !== undefined) frame.cursor = cursor
  return frame
}

// ev builds one wire event, data is the payload object control-api.md documents.
export function ev(name: string, seq: number, data?: unknown): WireEvent {
  const event: WireEvent = { event: name, seq }
  if (data !== undefined) event.data = data
  return event
}

export function entryAppend(seq: number, e: Entry): WireEvent {
  return ev('entry.append', seq, { entry: e })
}
