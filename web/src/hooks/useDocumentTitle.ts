import { useEffect } from 'react'

import { useWorkspace } from '../providers/workspace'

// The product name every tab title ends with, index.html's static <title> too.
const productName = 'ajent-swarm'

// composeTitle joins the gated needs-input count prefix and a route label over
// the product name: "(2) Refactor parser · ajent-swarm". An empty part drops,
// so a quiet sessions list reads "Sessions · ajent-swarm" and nothing at all
// reads as the bare product name.
export function composeTitle(label: string, count: number): string {
  const prefix = count > 0 ? `(${count}) ` : ''
  return `${prefix}${label === '' ? '' : `${label} · `}${productName}`
}

// useDocumentTitle sets the tab title for one route surface from its label and
// the workspace context's gated needs-input count, writing in an effect so a
// navigation keeps the previous title until the new route renders. Hosted panes
// pass enabled false: their workspace owns the one title.
export function useDocumentTitle(label: string, options?: { enabled?: boolean }) {
  const { titleCount } = useWorkspace()
  const enabled = options?.enabled ?? true
  useEffect(() => {
    if (!enabled) return
    document.title = composeTitle(label, titleCount)
  }, [label, titleCount, enabled])
}
