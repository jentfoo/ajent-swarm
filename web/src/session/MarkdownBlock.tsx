import { cloneElement, isValidElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Components } from 'react-markdown'
import type * as React from 'react'

import { CodeBlock } from './CodeBlock'

// Model output is untrusted input: the sanitizer drops raw HTML, scripts and
// event handlers while GFM's tables, strikethrough and task lists pass. Raw
// HTML stays disabled here, a hard requirement rather than a checklist line.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // keep the language tag so fences reach the shiki highlighter
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^language-/]],
  },
}

export function MarkdownBlock({ text }: { text: string }) {
  return (
    // prose carries the shared reading measure; user and assistant message
    // text both render here, tool cards, diffs and code never do
    <div className="markdown prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

// Code fences route through the shiki highlighter, inline code stays plain.
// Links open a new tab so a cited URL never unloads the session view, and
// tables scroll in their own port instead of widening a tile pane, each
// column floored at its longest cell's width
const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: CodeRenderer,
  a: LinkRenderer,
  table: TableRenderer,
}

interface LinkRendererProps {
  href?: string
  children?: React.ReactNode
}

// the sanitizer strips dangerous hrefs, so a missing one means the link was
// unsafe: bare text beats an anchor to nowhere
function LinkRenderer({ href, children }: LinkRendererProps) {
  if (href === undefined || href.startsWith('javascript:')) {
    return <>{children}</>
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in new tab)</span>
    </a>
  )
}

interface TableRendererProps {
  children?: React.ReactNode
}

// a column floors at its longest cell's width in ch, capped so one very long
// column cannot dominate the scroll port; shorter columns keep natural size
const maxColumnMinChars = 16

// the wrapper is a named focus stop, so keyboard users can reach and pan a
// table wider than its pane
function TableRenderer({ children }: TableRendererProps) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Scrollable table">
      <table>{withColumnMinWidths(children)}</table>
    </div>
  )
}

// markdown host elements arrive loosely typed, these props are all we touch
interface MarkdownElementProps {
  children?: React.ReactNode
  style?: React.CSSProperties
}
type MarkdownElement = React.ReactElement<MarkdownElementProps>

// measure per-column floors from the cell text, then clone each row with
// min-width styles; both passes count element children in order, so slots
// line up across rows even when sections split them
function withColumnMinWidths(table: React.ReactNode): React.ReactNode {
  const widths: number[] = []
  forEachRow(table, (cells) => {
    let column = 0
    for (const cell of cells) {
      const count = Math.min(cellCharCount(cell), maxColumnMinChars)
      if (count > (widths[column] ?? 0)) widths[column] = count
      column++
    }
  })
  return flooredRows(table, widths)
}

// rows live under thead/tbody sections; recurse until a tr, then visit its cells
function forEachRow(node: React.ReactNode, visit: (cells: MarkdownElement[]) => void) {
  for (const el of childElements(node)) {
    if (el.type === 'tr') {
      visit(childElements(el.props.children))
      continue
    }
    forEachRow(el.props.children, visit)
  }
}

function flooredRows(node: React.ReactNode, widths: number[]): React.ReactNode {
  if (Array.isArray(node)) return node.map((child) => flooredRows(child, widths))
  if (!isValidElement(node)) return node
  const el = node as MarkdownElement
  if (el.type === 'tr') {
    let column = 0
    const cells = childNodes(el.props.children).map((child) => {
      if (!isValidElement(child)) return child
      const cell = child as MarkdownElement
      const width = widths[column++]
      if (width === undefined) return cell
      // merge, never clobber: alignment rides the same inline style
      return cloneElement(cell, { style: { ...cell.props.style, minWidth: `${width}ch` } })
    })
    return cloneElement(el, undefined, cells)
  }
  return cloneElement(el, undefined, flooredRows(el.props.children, widths))
}

// element children only; a stray text node between cells never takes a slot
function childElements(node: React.ReactNode): MarkdownElement[] {
  if (Array.isArray(node)) return node.flatMap(childElements)
  if (!isValidElement(node)) return []
  return [node as MarkdownElement]
}

function childNodes(node: React.ReactNode): React.ReactNode[] {
  return Array.isArray(node) ? node : [node]
}

// collapsed text length; markdown renders cell whitespace the same way
function cellCharCount(cell: MarkdownElement): number {
  return inlineText(cell.props.children).replace(/\s+/g, ' ').trim().length
}

function inlineText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(inlineText).join('')
  if (!isValidElement(node)) return ''
  const el = node as MarkdownElement
  return inlineText(el.props.children)
}

interface CodeRendererProps {
  className?: string
  children?: React.ReactNode
}

function CodeRenderer({ className, children }: CodeRendererProps) {
  const text = String(children ?? '')
  if (text.includes('\n')) {
    return <CodeBlock code={stripTrailingNewline(text)} lang={languageOf(className)} />
  }
  return <code>{text}</code>
}

function languageOf(className: string | undefined): string | undefined {
  return /language-([\w+-]+)/.exec(className ?? '')?.[1]
}

function stripTrailingNewline(code: string): string {
  return code.endsWith('\n') ? code.slice(0, -1) : code
}
