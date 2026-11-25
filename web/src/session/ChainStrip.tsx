import { useState } from 'react'

import { ApiError } from '../api/client'
import { describeError } from '../api/errors'
import { chainsApi } from '../api/endpoints'
import { chainEditable } from '../api/types'
import type { Chain } from '../api/types'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { CloseIcon } from '../ui/icons'
import { useSessionNamer } from '../session/useSessionLabel'
import { useSwarm } from '../providers/swarm'
import { useWorkspace } from '../providers/workspace'

// ChainStrip renders one session's live chain links beside the queue chips:
// the child's wait on its parent (or a fresh failure cause) and the parent's
// hand-off into its child. Each link cancels through its own chain id and
// edits from a freshly read record, so both affordances target the right
// chain even on a session chained in both directions. QueuedPrompts stays
// untouched: chain links are not queue rows and never recall or expire.
export function ChainStrip({ sessionId }: { sessionId: string }) {
  const { itemFor, setChainDraft, chainById, refreshChain } = useWorkspace()
  const nameFor = useSessionNamer()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')

  const item = itemFor(sessionId)
  const inbound = item?.chainedOn
  const outbound = item?.deliveringTo

  const openEdit = async (link: { chainId: string }) => {
    if (opening) return
    setOpening(true)
    setError('')
    const fresh = await refreshChain(link.chainId)
    setOpening(false)
    if (fresh === undefined) {
      setError('Reading the chain failed. Try again.')
      return
    }
    if (!chainEditable(fresh.state)) {
      setError('This chain moved past its edit point.')
      return
    }
    setChainDraft({ parentId: fresh.parentId, childId: fresh.childId, chain: fresh })
  }

  const links: {
    key: string
    chainId: string
    text: string
    live: boolean
    record?: Chain
  }[] = []
  if (inbound !== undefined && item?.chainedOnId !== undefined) {
    links.push({
      key: `in-${item.chainedOnId}`,
      chainId: item.chainedOnId,
      // the failure line rides the digest beside the link, not as its reason
      text:
        item.chainFailure !== undefined
          ? `chain failed: ${item.chainFailure}`
          : `waiting on ${nameFor(inbound)}`,
      live: item.chainFailure === undefined,
      record: chainById(item.chainedOnId),
    })
  }
  if (outbound !== undefined && item?.deliveringId !== undefined) {
    links.push({
      key: `out-${item.deliveringId}`,
      chainId: item.deliveringId,
      text:
        item.chainFailure !== undefined
          ? `chain failed: ${item.chainFailure}`
          : `hands off into ${nameFor(outbound)}`,
      live: item.chainFailure === undefined,
      record: chainById(item.deliveringId),
    })
  }
  if (links.length === 0) return null

  return (
    <div className="chips" aria-label="Session chains">
      {links.map((link) => {
        const { record } = link
        // an unfetched record still offers edit: the click reads current state,
        // while a known terminal-or-delivering record can hide its button
        const editable = link.live && (record === undefined || chainEditable(record.state))
        return (
          <span key={link.key} className="chain-strip mono">
            {link.text}
            <span className={link.live ? 'badge warn' : 'badge danger'}>
              {link.live ? 'chained' : 'failed'}
            </span>
            {editable && (
              <button
                type="button"
                title="Edit this chain's prompts"
                disabled={opening}
                onClick={() => void openEdit(link)}
              >
                ✎ edit
              </button>
            )}
            {link.live && <CancelLink chainId={link.chainId} onError={setError} />}
          </span>
        )
      })}
      {error !== '' && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

// CancelLink is one link's armed cancel: stopping a link breaks every link
// stacked behind it, so the first press asks and the second confirms.
function CancelLink({ chainId, onError }: { chainId: string; onError: (message: string) => void }) {
  const { refreshAttention } = useSwarm()
  const [busy, setBusy] = useState(false)

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    onError('')
    try {
      await chainsApi.cancel(chainId)
    } catch (err) {
      // a gone chain settles the strip, every other refusal stays visible
      if (!(err instanceof ApiError && err.code === 'chain_not_found')) {
        onError(describeError(err, 'Canceling the chain failed.'))
        return
      }
    } finally {
      setBusy(false)
    }
    void refreshAttention()
  }

  const confirm = useArmedConfirm(() => void cancel(), { disabled: busy })

  return (
    <button
      type="button"
      title="Cancel this chain and the links stacked behind it"
      className={`danger${confirm.armed ? ' armed' : ''}`}
      disabled={busy}
      onBlur={confirm.onBlur}
      onClick={confirm.onClick}
    >
      {confirm.armed ? (
        'cancel chain?'
      ) : (
        <>
          <CloseIcon size={14} />
          cancel
        </>
      )}
    </button>
  )
}
