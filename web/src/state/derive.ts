// Pure derivation of transcript blocks from committed entries. One walk
// mirrors what ajent's replay paints for the same branch, so a live append
// and its backfilled entry can never disagree on what they are:
//
//   - user messages classify as user, tool-result carrier or injected
//     context (replayed or not) by the shared rule in pkg/session/replay.go
//   - tool results fold under the call headers they answer, a result whose
//     call is absent renders standalone
//   - compaction draws as a divider, notices stay level-tinted, and unknown
//     entry types render as muted generic cards
//
// hideLiveToolIds drops committed calls whose live card has not retired yet,
// the handoff that keeps streamed content painting once while it runs.
import type { Entry } from '../api/types'
import {
  toolCallId,
  userRanPrefix,
  type ContentBlockView,
  type MessageEntryData,
} from './eventApplier'

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
  fault?: string // upstream error notice carrying the panic's fault location
}

export interface ToolCallInfo {
  id: string
  name: string
  input?: unknown
  result?: ToolResultView
  verdict?: string // permit outcome chip captured from the live stream
}

export type AssistantPart = { kind: 'text'; text: string } | { kind: 'call'; call: ToolCallInfo }

export type DerivedBlock =
  | { kind: 'user'; id: string; text: string; images: ImageView[] }
  | {
      kind: 'injected'
      id: string
      replayed: boolean
      shellRun: boolean // a staged shell run's flush, matching its live card
      label: string
      body: string
    }
  | {
      kind: 'assistant'
      id: string
      parts: AssistantPart[] // content-block order, edits land where they happened
      thinking: string[]
      stop?: string
    }
  | { kind: 'tool-results'; id: string; results: ToolResultView[] }
  | { kind: 'system'; id: string; entry: Entry }
  | { kind: 'compaction'; id: string }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'unknown'; id: string; type: string }

export function deriveBlocks(
  chainIds: readonly string[],
  entries: Map<string, Entry>,
  hideLiveToolIds: ReadonlySet<string> = new Set(),
  verdicts?: ReadonlyMap<string, string>, // tool call id -> permit chip label
): DerivedBlock[] {
  const pendingCalls = new Map<string, ToolCallInfo>()
  const blocks: DerivedBlock[] = []
  for (const id of chainIds) {
    const entry = entries.get(id)
    if (!entry) continue
    switch (entry.type) {
      case 'message': {
        const block = deriveMessage(entry, pendingCalls, hideLiveToolIds, verdicts)
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

// The recall sources keep to the newest 500 typed prompts: a search never
// needs deeper history and every returned list stays bounded.
export const maxRecallPrompts = 500

// RecallPrompt is one recall candidate beside its commit time, unix
// milliseconds, so the session and workspace sources interleave under one
// ordering. ts 0 means unknown: the candidate sorts oldest.
export interface RecallPrompt {
  text: string
  ts: number
}

// recallPrompts collects one session's committed typed prompts, newest first
// and deduplicated: the session-local recall source the Ctrl+R search and the
// post-accept arrow browsing share. Injected context and tool-result carriers
// never recall, the same exclusion ajent's recall applies, and empty texts (an
// image-only prompt) drop out.
export function recallPrompts(
  chainIds: readonly string[],
  entries: Map<string, Entry>,
): RecallPrompt[] {
  const blocks = deriveBlocks(chainIds, entries)
  const seen = new Set<string>()
  const out: RecallPrompt[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.kind !== 'user' || block.text === '' || seen.has(block.text)) continue
    seen.add(block.text)
    out.push({ text: block.text, ts: entries.get(block.id)?.ts ?? 0 })
    if (out.length === maxRecallPrompts) break
  }
  return out
}

// mergeRecallSources interleaves the workspace mirror with the session's own
// committed prompts under one newest-first order, deduplicating to each text's
// newest occurrence and capped like either source alone.
export function mergeRecallSources(
  local: readonly RecallPrompt[],
  workspace: readonly RecallPrompt[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const merged = [...local, ...workspace].sort((a, b) => b.ts - a.ts) // stable: ties keep source order
  for (const p of merged) {
    if (p.text === '' || seen.has(p.text)) continue
    seen.add(p.text)
    out.push(p.text)
    if (out.length === maxRecallPrompts) break
  }
  return out
}

// deriveNotice keeps a committed notice's level tint, the wire key is
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
  verdicts?: ReadonlyMap<string, string>,
): DerivedBlock | undefined {
  const d = (entry.data ?? {}) as MessageEntryData
  const role = d.message?.role
  const blocks = Array.isArray(d.message?.content) ? (d.message!.content as ContentBlockView[]) : []

  if (role === 'assistant') {
    return deriveAssistant(entry.id, blocks, pendingCalls, hideLiveToolIds, verdicts, d.stop)
  }
  if (role !== 'user') {
    // system-role messages carry no standalone shape, replay paints nothing
    return undefined
  }

  const text = joinText(blocks)
  if (d.injected) {
    // injected context opens no turn, it draws only when replay-marked,
    // matching replay's InjectBlock path
    if (!d.replayed) return undefined
    const inject = splitInject(text)
    if (!inject) return undefined
    return {
      kind: 'injected',
      id: entry.id,
      replayed: true,
      shellRun: inject.label.startsWith(userRanPrefix),
      ...inject,
    }
  }

  const results = foldResults(blocks, pendingCalls)
  if (isCarrier(blocks)) {
    return results.length > 0 ? { kind: 'tool-results', id: entry.id, results } : undefined
  }
  return { kind: 'user', id: entry.id, text, images: collectImages(blocks) }
}

// splitInject mirrors upstream's agent.InjectBlock shape: the first line is
// the header label, the body drops only the blank lines that separated it, and
// a blank label paints nothing at all. Everything else survives verbatim.
function splitInject(text: string): { label: string; body: string } | undefined {
  const cut = text.indexOf('\n')
  const label = cut === -1 ? text : text.slice(0, cut)
  if (label.trim() === '') return undefined
  return { label, body: cut === -1 ? '' : text.slice(cut + 1).replace(/^\n+/, '') }
}

function deriveAssistant(
  id: string,
  blocks: ContentBlockView[],
  pendingCalls: Map<string, ToolCallInfo>,
  hideLiveToolIds: ReadonlySet<string>,
  verdicts: ReadonlyMap<string, string> | undefined,
  stop?: string,
): DerivedBlock {
  const parts: AssistantPart[] = []
  const thinking: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if ((block.data?.text ?? '') !== '') parts.push({ kind: 'text', text: block.data!.text! })
        break
      case 'thinking':
        if ((block.data?.text ?? '') !== '') thinking.push(block.data!.text!)
        break
      case 'tool_call': {
        const callId = str(block.data?.id)
        if (callId === '') break
        // The pending map and any rendered part share one info object, so a
        // folded result shows on the card and a hidden call still receives it.
        const info: ToolCallInfo = {
          id: callId,
          name: str(block.data?.name),
          input: block.data?.input,
        }
        const verdict = verdicts?.get(callId)
        if (verdict !== undefined) info.verdict = verdict
        pendingCalls.set(callId, info)
        if (!hideLiveToolIds.has(callId)) parts.push({ kind: 'call', call: info })
        break
      }
      default:
        break
    }
  }
  return { kind: 'assistant', id, parts, thinking, stop: stop || undefined }
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
    const callId = toolCallId(block) ?? ''
    const view: ToolResultView = {
      callId,
      toolName: optStr(block.data?.toolName),
      text: resultText(block),
      images: collectImages(resultContent(block)),
      isError: block.data?.isError === true,
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
  if (block.data?.display !== undefined && block.data.display !== '') return block.data.display
  return joinText(resultContent(block))
}

function resultContent(block: ContentBlockView): unknown[] {
  return Array.isArray(block.data?.content) ? block.data.content : []
}

function collectBlocks(blocks: readonly unknown[], types: string[]): ContentBlockView[] {
  return blocks.filter((b): b is ContentBlockView =>
    types.includes((b as ContentBlockView)?.type ?? ''),
  )
}

// the one text-body join JoinText shape labels and rewind candidates share
function joinText(blocks: readonly unknown[]): string {
  const texts = collectBlocks(blocks, ['text'])
    .map((b) => str(b.data?.text))
    .filter((t) => t !== '')
  return texts.join('\n\n')
}

function collectImages(blocks: readonly unknown[]): ImageView[] {
  return collectBlocks(blocks, ['image']).map((b) => ({
    mediaType: str(b.data?.mediaType),
    data: optStr(b.data?.data),
  }))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}
