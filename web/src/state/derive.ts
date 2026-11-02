// Pure derivation of transcript blocks from committed entries. One walk
// mirrors what ajent's replay paints for the same branch, so a live append
// and its backfilled entry can never disagree on what they are:
//
//   - user messages classify as prompt, tool-result carrier or injected
//     context (replayed or not) by the shared rule in pkg/session/replay.go
//   - tool results fold under the call headers they answer; a result whose
//     call is absent renders standalone
//   - compaction draws as a divider, notices stay level-tinted, and unknown
//     entry types render as muted generic cards
//
// hideLiveToolIds drops committed calls whose live card has not retired yet,
// the handoff that keeps streamed content painting once while it runs.
import type { Entry } from '../api/types'
import type { ContentBlockView } from './eventApplier'

export interface ImageView {
  mediaType: string
  data?: string // base64 body; absent when the server deferred it
}

export interface ToolResultView {
  callId: string
  toolName?: string
  text: string // display text when set, else the joined content bodies
  images: ImageView[]
  isError: boolean
}

export interface ToolCallInfo {
  id: string
  name: string
  input?: unknown
  result?: ToolResultView
}

export type DerivedBlock =
  | { kind: 'prompt'; id: string; text: string; images: ImageView[] }
  | { kind: 'injected'; id: string; replayed: boolean; text: string }
  | {
      kind: 'assistant'
      id: string
      texts: string[]
      thinking: string[]
      calls: ToolCallInfo[]
      stop?: string
    }
  | { kind: 'tool-results'; id: string; results: ToolResultView[] }
  | { kind: 'system'; id: string; entry: Entry }
  | { kind: 'compaction'; id: string }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'unknown'; id: string; type: string }

interface MessageDataView {
  message?: { role?: string; content?: unknown }
  stop?: string
  injected?: boolean
  replayed?: boolean
}

export function deriveBlocks(
  chainIds: readonly string[],
  entries: Map<string, Entry>,
  hideLiveToolIds: ReadonlySet<string> = new Set(),
): DerivedBlock[] {
  const pendingCalls = new Map<string, ToolCallInfo>()
  const blocks: DerivedBlock[] = []
  for (const id of chainIds) {
    const entry = entries.get(id)
    if (!entry) continue
    switch (entry.type) {
      case 'message': {
        const block = deriveMessage(entry, pendingCalls, hideLiveToolIds)
        if (block) blocks.push(block)
        break
      }
      case 'notice':
        blocks.push(deriveNotice(entry))
        break
      case 'compaction':
        blocks.push({ kind: 'compaction', id: entry.id })
        break
      default:
        if (isSystemType(entry.type)) {
          blocks.push({ kind: 'system', id: entry.id, entry })
        } else {
          blocks.push({ kind: 'unknown', id: entry.id, type: entry.type })
        }
    }
  }
  return blocks
}

// deriveNotice keeps a committed notice's level tint; the wire key is
// `message` here where live notice events use `text`.
function deriveNotice(entry: Entry): DerivedBlock {
  const d = (entry.data ?? {}) as { message?: string; level?: string }
  const level = d.level === 'warn' || d.level === 'error' ? d.level : 'info'
  return { kind: 'notice', id: entry.id, level, text: d.message ?? '' }
}

// isSystemType names the entry types that render as system chips. Unknown
// payload fields round-trip upstream, so anything unfamiliar stays generic.
function isSystemType(type: string): boolean {
  switch (type) {
    case 'session':
    case 'model_change':
    case 'setting_change':
    case 'session_name':
    case 'custom':
      return true
    default:
      return false
  }
}

// deriveMessage classifies one committed message by the replay rule. A
// carrier whose every result folded under a call renders nothing: its content
// already shows on those cards.
function deriveMessage(
  entry: Entry,
  pendingCalls: Map<string, ToolCallInfo>,
  hideLiveToolIds: ReadonlySet<string>,
): DerivedBlock | undefined {
  const d = (entry.data ?? {}) as MessageDataView
  const role = d.message?.role
  const blocks = Array.isArray(d.message?.content) ? (d.message!.content as ContentBlockView[]) : []

  if (role === 'assistant') {
    return deriveAssistant(entry.id, blocks, pendingCalls, hideLiveToolIds, d.stop)
  }
  if (role !== 'user') {
    // system-role messages carry no standalone shape; replay paints nothing
    return undefined
  }

  const text = joinText(blocks, ['text'])
  if (d.injected) {
    // injected context opens no turn; it draws only when replay-marked,
    // matching replay's InjectBlock path
    if (!d.replayed || (text === '' && blocks.length === 0)) return undefined
    return { kind: 'injected', id: entry.id, replayed: true, text }
  }

  const results = foldResults(blocks, pendingCalls)
  if (isCarrier(blocks)) {
    return results.length > 0 ? { kind: 'tool-results', id: entry.id, results } : undefined
  }
  return { kind: 'prompt', id: entry.id, text, images: collectImages(blocks) }
}

function deriveAssistant(
  id: string,
  blocks: ContentBlockView[],
  pendingCalls: Map<string, ToolCallInfo>,
  hideLiveToolIds: ReadonlySet<string>,
  stop?: string,
): DerivedBlock {
  const texts: string[] = []
  const thinking: string[] = []
  const calls: ToolCallInfo[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if ((block.data?.text ?? '') !== '') texts.push(block.data!.text!)
        break
      case 'thinking':
        if ((block.data?.text ?? '') !== '') thinking.push(block.data!.text!)
        break
      case 'tool_call': {
        const callId = str(block.data?.id)
        if (callId === '') break
        // One info object lands in both places, so a folded result shows on
        // the rendered card and a hidden call still receives its result.
        const info: ToolCallInfo = {
          id: callId,
          name: str(block.data?.name),
          input: block.data?.input,
        }
        pendingCalls.set(callId, info)
        if (!hideLiveToolIds.has(callId)) calls.push(info)
        break
      }
      default:
        break
    }
  }
  return { kind: 'assistant', id, texts, thinking, calls, stop: stop || undefined }
}

// foldResults attaches tool results to the call headers they answer. Results
// without a call render standalone, replay's one tool-result fallback.
function foldResults(
  blocks: ContentBlockView[],
  pendingCalls: Map<string, ToolCallInfo>,
): ToolResultView[] {
  const orphan: ToolResultView[] = []
  for (const block of blocks) {
    if (block.type !== 'tool_result') continue
    const callId = str(block.data?.callId)
    const view: ToolResultView = {
      callId,
      toolName: optStr((block as { data?: { toolName?: string } }).data?.toolName),
      text: resultText(block),
      images: collectImages(resultContent(block)),
      isError: (block as { data?: { isError?: boolean } }).data?.isError === true,
    }
    const call = pendingCalls.get(callId)
    if (call && !call.result) {
      call.result = view
    } else {
      orphan.push(view)
    }
  }
  return orphan
}

// isCarrier applies the replay rule: a user message whose content is tool
// results alone, with at least one present.
function isCarrier(blocks: ContentBlockView[]): boolean {
  if (blocks.length === 0) return false
  return blocks.every((b) => b.type === 'tool_result')
}

// resultText prefers the display body history shows when it differs from what
// the model saw, else the joined content text.
function resultText(block: ContentBlockView): string {
  const data = block as { data?: { display?: string; content?: unknown } }
  if (data.data?.display !== undefined && data.data.display !== '') return data.data.display
  return joinText(resultContent(block), ['text'])
}

function resultContent(block: ContentBlockView): unknown[] {
  const content = (block as { data?: { content?: unknown } }).data?.content
  return Array.isArray(content) ? content : []
}

function collectBlocks(blocks: readonly unknown[], types: string[]): ContentBlockView[] {
  return blocks.filter((b): b is ContentBlockView =>
    types.includes((b as ContentBlockView)?.type ?? ''),
  )
}

// joinText concatenates one block family's bodies, the JoinText shape labels
// and rewind candidates use.
function joinText(blocks: readonly unknown[], types: string[]): string {
  const texts = collectBlocks(blocks, types)
    .map((b) => str(b.data?.text))
    .filter((t) => t !== '')
  return texts.join('\n\n')
}

function collectImages(blocks: readonly unknown[]): ImageView[] {
  return collectBlocks(blocks, ['image']).map((b) => ({
    mediaType: str(b.data?.mediaType),
    data: optStr((b as { data?: { data?: string } }).data?.data),
  }))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}
