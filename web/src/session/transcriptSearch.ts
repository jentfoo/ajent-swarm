// Pure transcript-find machinery: searchable text extraction from derived
// blocks and their anchored diffs, the case-insensitive matcher over that
// index, and the selection helpers the view's find surface rides. A block's
// visible meaning is what matches, rendered text rather than internal wire
// state: message bodies, thinking, tool arguments and outputs as painted,
// injected context, diff content and system labels.
import { parseEditInput } from './editInput'
import { matchSpans } from './historySearch'
import { prettyInput } from './toolInput'
import type { DerivedBlock } from '../state/derive'
import type { DiffView } from '../state/eventApplier'

// SearchRegion is one visible piece of a block: the role the find surface
// names beside a snippet and the text that matches.
export interface SearchRegion {
  label: string
  text: string
}

// SearchBlock is one virtual row's searchable shape: the block that scrolls
// into view and the regions matched inside it.
export interface SearchBlock {
  id: string
  blockIdx: number // index into the derived block list, scrollToIndex's target
  regions: SearchRegion[]
}

// TranscriptMatch locates one hit inside a region: the row that scrolls,
// where the hit sits for stepping, and the flattened context the surface
// shows with the match marked.
export interface TranscriptMatch {
  blockId: string
  blockIdx: number
  region: number // index into the block's regions
  at: number // match offset inside the region's text
  label: string
  snippet: string
  markAt: number // the hit inside the snippet, flattened offsets
  markEnd: number
}

// snippetWindow is how much flattened context a match's snippet keeps either
// side of the hit.
const snippetWindow = 48

// buildSearchIndex extracts the searchable regions of one transcript's
// committed blocks. Anchored diffs join the row they ride beneath; trailing
// diffs have no row and stay out of the index.
export function buildSearchIndex(
  blocks: readonly DerivedBlock[],
  anchoredDiffs: ReadonlyMap<string, readonly DiffView[]>,
): SearchBlock[] {
  const out: SearchBlock[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const regions = blockRegions(block)
    for (const d of anchoredDiffs.get(block.id) ?? []) {
      regions.push({ label: 'diff', text: `${d.path}\n${d.before}\n${d.after}` })
    }
    if (regions.length === 0) continue
    out.push({ id: block.id, blockIdx: i, regions })
  }
  return out
}

// blockRegions reads one block's visible meaning. Collapsed content counts:
// thinking, parent responses and tool bodies all render behind disclosures.
function blockRegions(block: DerivedBlock): SearchRegion[] {
  switch (block.kind) {
    case 'user':
      return [{ label: 'user', text: block.text }]
    case 'chained':
      return [
        { label: 'chained prompt', text: block.prompt },
        { label: 'parent response', text: block.body },
      ]
    case 'injected':
      return [{ label: 'context', text: `${block.label}\n${block.body}` }]
    case 'assistant': {
      const regions: SearchRegion[] = block.thinking.map((text) => ({ label: 'thinking', text }))
      for (const part of block.parts) {
        if (part.kind === 'text') {
          regions.push({ label: 'assistant', text: part.text })
          continue
        }
        const { call } = part
        regions.push({
          label: `tool ${call.name}`.trim(),
          text: `${call.name}\n${toolInputText(call.name, call.input)}`,
        })
        if (call.result !== undefined) {
          regions.push({ label: 'tool output', text: call.result.fault ?? call.result.text })
        }
      }
      return regions
    }
    case 'tool-results':
      return block.results.map((r) => ({
        label: r.toolName === undefined ? 'tool output' : `tool ${r.toolName}`,
        text: r.fault ?? r.text,
      }))
    case 'system':
      // the chip label the derivation computed, the search matches it verbatim
      return [{ label: 'system', text: block.label }]
    case 'compaction':
      return [{ label: 'compaction', text: 'context compacted' }]
    case 'notice':
      return [
        { label: block.level === 'info' ? 'notice' : `${block.level} notice`, text: block.text },
      ]
    case 'unknown':
      return [{ label: 'unknown', text: `[${block.type}]` }]
  }
}

// toolInputText mirrors what ToolInputView paints: edit calls render their op
// texts as the card's diff, everything else pretty-printed arguments.
function toolInputText(name: string, input: unknown): string {
  const edit = name === 'edit' ? parseEditInput(input) : undefined
  if (edit === undefined) return prettyInput(input)
  const ops = edit.ops.map((op) => `${op.oldText}\n${op.newText}`)
  return `${edit.path}\n${ops.join('\n')}`
}

// matchBlocks finds every case-insensitive occurrence of the query, ordered
// by document position: block, then region, then offset. A blank query
// matches nothing, so a freshly opened surface shows no results yet.
export function matchBlocks(index: readonly SearchBlock[], query: string): TranscriptMatch[] {
  const out: TranscriptMatch[] = []
  if (query.trim() === '') return out
  for (const block of index) {
    for (let r = 0; r < block.regions.length; r++) {
      const region = block.regions[r]
      for (const [start, end] of matchSpans(region.text, query)) {
        out.push({
          blockId: block.id,
          blockIdx: block.blockIdx,
          region: r,
          at: start,
          label: region.label,
          ...matchSnippet(region.text, start, end, query),
        })
      }
    }
  }
  return out
}

// matchSnippet flattens the hit's surroundings into one context line and
// locates the hit inside it, so the surface can emphasize the match without
// the transcript itself changing.
function matchSnippet(
  text: string,
  start: number,
  end: number,
  query: string,
): { snippet: string; markAt: number; markEnd: number } {
  const from = Math.max(0, start - snippetWindow)
  const to = Math.min(text.length, end + snippetWindow)
  const head = from > 0
  const tail = to < text.length
  const body = flatten(text.slice(from, to))
  // flattening shifts offsets, so the hit is located again inside the line;
  // the occurrence covering the expected position wins, falling back to the
  // first when flattening changed the bytes the query matched through
  const spans = matchSpans(body, query)
  const expect = flatten(text.slice(from, start)).length
  const span = spans.find(([s, e]) => s <= expect && e >= expect) ?? spans[0]
  const shift = head ? 1 : 0
  return {
    snippet: `${head ? '…' : ''}${body}${tail ? '…' : ''}`,
    markAt: span === undefined ? 0 : span[0] + shift,
    markEnd: span === undefined ? 0 : span[1] + shift,
  }
}

// flatten collapses whitespace runs, so a multi-line region reads as one
// context line in the find surface.
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ')
}

// sameMatch compares two matches' coordinates, the identity the view keeps
// across reconciliation.
export function sameMatch(a: TranscriptMatch, b: TranscriptMatch): boolean {
  return a.blockId === b.blockId && a.region === b.region && a.at === b.at
}

// nearestFromAnchor picks the deterministic first result for a fresh query:
// the first match on or after the reading anchor's row, else the last match.
// Empty match lists answer -1.
export function nearestFromAnchor(matches: readonly TranscriptMatch[], blockIdx: number): number {
  const at = matches.findIndex((m) => m.blockIdx >= blockIdx)
  return at === -1 ? matches.length - 1 : at
}

// nearestFrom picks the match nearest a vanished one: the first result at or
// after its document position, else the last match.
export function nearestFrom(
  matches: readonly TranscriptMatch[],
  ref: { region: number; at: number },
  refBlockIdx: number,
): number {
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    if (m.blockIdx !== refBlockIdx) {
      if (m.blockIdx > refBlockIdx) return i
      continue
    }
    if (m.region !== ref.region) {
      if (m.region > ref.region) return i
      continue
    }
    if (m.at >= ref.at) return i
  }
  return matches.length - 1
}
