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
// tables scroll in their own port instead of widening a tile pane.
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

// the wrapper is a named focus stop, so keyboard users can reach and pan a
// table wider than its pane
function TableRenderer({ children }: TableRendererProps) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label="Scrollable table">
      <table>{children}</table>
    </div>
  )
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
