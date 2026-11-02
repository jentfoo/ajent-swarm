import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Components } from 'react-markdown'

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
    <div className="markdown">
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

// Code fences route through the shiki highlighter; inline code stays plain.
const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: CodeRenderer,
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
