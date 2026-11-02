import { useCallback, useState } from 'react'
import { useParams } from 'react-router'

import { ApiError, post } from '../api/client'
import { sessions as sessionAPI } from '../api/endpoints'
import type { Entry, InteractionPending } from '../api/types'
import { useSessionChannel } from '../hooks/useSessionChannel'
import type { DiffView, LiveTurn, NoticeView, PrintCard } from '../state/eventApplier'
import type { SessionPhase } from '../stream/swarmStream'

// SessionView renders the reconciled state as plain blocks: committed history
// from the entry chain, live turn buffers beneath it. Polish (markdown, tool
// cards, composer) arrives in phase 08 on top of this channel.
export default function SessionView() {
  const { sessionId = '' } = useParams()
  const { state, phase, loadOlder } = useSessionChannel(sessionId)
  const snap = state.snapshot

  return (
    <>
      <div className="session-header">
        <h1 style={{ margin: 0, fontSize: 'inherit' }}>
          {snap.session.name || snap.session.id || sessionId}
        </h1>
        <PhaseBadge phase={phase} exitReason={state.exitReason} />
        {snap.running && <span className="badge accent">running</span>}
        {snap.spinning && <span className="badge warn">working</span>}
        {!snap.running && snap.idle && !snap.spinning && <span className="badge">idle</span>}
        <SeatBadge
          holder={snap.seat.holder}
          held={snap.seat.held}
          yours={snap.seat.yours}
          sessionId={sessionId}
        />
      </div>

      <StatusLine
        model={snap.model.short || snap.model.key}
        permission={snap.permission}
        contextUsed={snap.context.used}
        contextWindow={snap.context.window}
        queued={snap.queued}
        turns={snap.usage.turns}
      />

      {phase !== 'live' && phase !== 'ended' && (
        <div className="banner info" role="status">
          {phaseText(phase)}
        </div>
      )}
      {(phase === 'ended' || state.exitReason !== undefined) && (
        <div className="banner warn" role="status">
          Session ended{state.exitReason ? `: ${state.exitReason}` : '.'}
        </div>
      )}

      {snap.interactions && snap.interactions.length > 0 && (
        <section aria-label="Open dialogs">
          <h2 style={{ fontSize: 'inherit' }}>Needs input</h2>
          {snap.interactions.map((dlg) => (
            <DialogCard key={dlg.id} dialog={dlg} sessionId={sessionId} />
          ))}
        </section>
      )}

      {(snap.queuedRows?.length ?? 0) > 0 && (
        <div className="chips" aria-label="Queued prompts">
          {snap.queuedRows!.map((row) => (
            <span key={row.id} className="queue-chip mono">
              {row.text === '' ? `secret row ${shortID(row.id)}` : row.text}
            </span>
          ))}
        </div>
      )}

      {state.pendings.length > 0 && (
        <div className="chips" aria-label="Pending prompts">
          {state.pendings.map((p) => (
            <span key={p.id} className="queue-chip mono">
              {p.text === '' ? 'secret row' : p.text} · {p.state}
            </span>
          ))}
        </div>
      )}

      {!state.chain.rooted && state.chain.ids.length > 0 && (
        <LoadOlderButton onClick={() => void loadOlder()} />
      )}

      <section className="blocks" aria-label="Transcript">
        {state.chain.ids.map((id) => (
          <EntryBlock key={id} entry={state.entries.get(id)!} />
        ))}
        {state.live && <LiveTurnBlock live={state.live} />}
      </section>

      {(state.notices.length > 0 || state.prints.length > 0 || state.diffs.length > 0) && (
        <EphemeralBlocks notices={state.notices} prints={state.prints} diffs={state.diffs} />
      )}
    </>
  )
}

function phaseText(phase: SessionPhase): string {
  switch (phase) {
    case 'connecting':
      return 'Connecting to the session stream…'
    case 'resyncing':
      return 'Connection was interrupted; resnapshotting…'
    case 'lost':
      return 'The session is not reachable right now. It will reappear when its control socket serves again.'
    default:
      return ''
  }
}

function PhaseBadge({ phase, exitReason }: { phase: SessionPhase; exitReason?: string }) {
  const label =
    phase === 'live'
      ? null
      : phase === 'connecting'
        ? 'connecting'
        : phase === 'resyncing'
          ? 'reconnecting'
          : phase === 'ended'
            ? `ended${exitReason ? `: ${exitReason}` : ''}`
            : 'lost'
  if (!label) return null
  return <span className={`badge ${phase === 'ended' ? '' : 'warn'}`}>{label}</span>
}

function SeatBadge({
  held,
  holder,
  yours,
  sessionId,
}: {
  held: boolean
  holder?: string
  yours: boolean
  sessionId: string
}) {
  const [busy, setBusy] = useState(false)
  const takeControl = useCallback(async () => {
    setBusy(true)
    try {
      await sessionAPI.takeControl(sessionId)
    } catch {
      // Refusals keep their holder name; the next snapshot updates the badge.
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  if (!held) return <span className="badge">seat free</span>
  if (yours) return <span className="badge accent">you hold the seat</span>
  return (
    <>
      <span className="badge warn">seat: {holder || 'another controller'}</span>
      <button type="button" onClick={() => void takeControl()} disabled={busy}>
        Take control
      </button>
    </>
  )
}

function StatusLine(props: {
  model: string
  permission: string
  contextUsed: number
  contextWindow: number
  queued: number
  turns: number
}) {
  const pct =
    props.contextWindow > 0 ? Math.min(100, (props.contextUsed / props.contextWindow) * 100) : 0
  return (
    <div className="chips">
      {props.model && <span className="badge accent">{props.model}</span>}
      {props.permission !== '' && <span className="badge">mode: {props.permission}</span>}
      {props.queued > 0 && <span className="badge">{props.queued} queued</span>}
      {props.turns > 0 && <span className="badge">{props.turns} turns</span>}
      {props.contextWindow > 0 && (
        <span
          className="meter"
          role="img"
          aria-label={`Context ${Math.round(pct)}% full`}
          title={`context ${props.contextUsed}/${props.contextWindow}`}
        >
          <div style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  )
}

function LoadOlderButton({ onClick }: { onClick: () => void }) {
  return (
    <p>
      <button type="button" onClick={onClick}>
        Load older history
      </button>
    </p>
  )
}

// --- committed entry blocks ---

interface ContentBlock {
  type?: string
  data?: {
    text?: string
    mediaType?: string
    data?: string // base64 body; absent when the server deferred it
    name?: string
    callId?: string
    id?: string
  }
}

function EntryBlock({ entry }: { entry: Entry }) {
  if (entry.type === 'message') return <MessageEntryBlock entry={entry} />
  if (entry.type === 'notice') {
    const d = entry.data as { message?: string; level?: string } | undefined
    return <div className={`block-notice ${d?.level ?? 'info'}`}>{d?.message ?? '[notice]'}</div>
  }
  return <SystemEntryBlock type={entry.type} data={entry.data} />
}

function MessageEntryBlock({ entry }: { entry: Entry }) {
  const d = entry.data as
    | {
        message?: { role?: string; content?: ContentBlock[] }
        stop?: string
        queueIds?: string[]
        injected?: boolean
        origin?: string
      }
    | undefined

  if (!d?.message) return <div className="muted mono">[unparsed message entry]</div>
  const blocks = d.message.content ?? []
  const texts: string[] = []
  const chips: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.data?.text) texts.push(block.data.text)
        break
      case 'thinking':
        chips.push('thinking')
        break
      case 'tool_call':
        chips.push(`tool: ${block.data?.name ?? block.data?.id ?? '?'}`)
        break
      case 'tool_result': {
        const deferred = hasDeferredImages(block)
        chips.push(deferred ? `tool results · [image placeholder]` : 'tool results')
        break
      }
      case 'image':
        // Deferred bodies render a placeholder until fetched at full fidelity.
        texts.push(
          block.data?.data !== undefined
            ? '[embedded image]'
            : `[image ${block.data?.mediaType ?? ''} not loaded]`,
        )
        break
      default:
        chips.push(block.type ?? 'unknown block')
    }
  }

  return (
    <div>
      <span className="block-role">
        {d.message.role}
        {d.injected ? ' · injected' : ''}
        {d.origin ? ` · via ${d.origin}` : ''}
        {d.stop ? ` · stop: ${d.stop}` : ''}
      </span>
      {(chips.length > 0 || d.queueIds) && (
        <div className="chips">
          {chips.map((c, i) => (
            <span key={i} className="badge">
              {c}
            </span>
          ))}
          {d.queueIds?.map((id) => (
            <span key={id} className="badge mono">
              prompt {shortID(id)}
            </span>
          ))}
        </div>
      )}
      {texts.map((text, i) => (
        <pre key={i} style={{ whiteSpace: 'pre-wrap', margin: '0.2em 0' }}>
          {text}
        </pre>
      ))}
    </div>
  )
}

function hasDeferredImages(block: ContentBlock): boolean {
  const inner = (block.data as { content?: ContentBlock[] } | undefined)?.content
  return (
    inner?.some(
      (b) => b.type === 'image' && b.data?.mediaType !== undefined && b.data?.data === undefined,
    ) ?? false
  )
}

function SystemEntryBlock({ type, data }: { type: string; data: unknown }) {
  const d = (data ?? {}) as Record<string, unknown>
  let text: string
  switch (type) {
    case 'session':
      text = `session · cwd ${String(d.cwd ?? '?')}${d.model ? ` · model ${String(d.model)}` : ''}`
      break
    case 'compaction':
      return (
        <div className="muted" style={{ textAlign: 'center', fontSize: '0.85em' }}>
          — context compacted —
        </div>
      )
    case 'model_change':
      text = `model changed to ${String(d.model ?? '?')}${d.reason ? ` (${String(d.reason)})` : ''}`
      break
    case 'setting_change':
      text = `setting ${String(d.key ?? '?')} = ${JSON.stringify(d.value)}`
      break
    case 'session_name':
      text = `renamed to ${String(d.name ?? '?')}`
      break
    case 'custom':
      text = `custom: ${String(d.customType ?? '?')}`
      break
    default:
      // Unknown types round-trip untouched; render generically rather than fail.
      text = `[${type}]`
  }
  return <div className="muted mono">{text}</div>
}

// --- live turn + ephemeral surfaces ---

function LiveTurnBlock({ live }: { live: LiveTurn }) {
  return (
    <div className="live-block">
      <span className="block-role">live{live.model ? ` · ${live.model}` : ''}</span>
      {live.thinking !== '' && (
        <p className="muted" style={{ fontStyle: 'italic' }}>
          thinking… {live.thinking}
        </p>
      )}
      {live.text !== '' && (
        <pre style={{ whiteSpace: 'pre-wrap', margin: '0.2em 0' }}>{live.text}</pre>
      )}
      {live.tools.map((tool) => (
        <div key={tool.id} className="tool-card">
          <span className="mono">{tool.name || tool.id}</span>{' '}
          {tool.result ? (
            tool.result.error ? (
              <span className="badge danger">failed</span>
            ) : (
              <span className="badge ok">done</span>
            )
          ) : (
            <span className="badge accent">running</span>
          )}
          {tool.outputs.length > 0 ? (
            // Deltas already painted the body: result.output adds nothing.
            <pre style={{ whiteSpace: 'pre-wrap' }}>{tool.outputs.join('')}</pre>
          ) : tool.result?.output ? (
            <pre style={{ whiteSpace: 'pre-wrap' }}>{tool.result.output}</pre>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function EphemeralBlocks(props: { notices: NoticeView[]; prints: PrintCard[]; diffs: DiffView[] }) {
  return (
    <>
      {props.diffs.length > 0 && (
        <div className="chips">
          {props.diffs.map((d, i) => (
            <span key={i} className="badge mono">
              diff: {d.path}
            </span>
          ))}
        </div>
      )}
      {props.notices.length > 0 && (
        <section aria-label="Notices">
          {props.notices.map((n, i) => (
            <div key={i} className={`block-notice ${n.level}`}>
              {n.text}
            </div>
          ))}
        </section>
      )}
      {props.prints.length > 0 && (
        <section aria-label="Printed blocks">
          {props.prints.map((p) => (
            <pre key={p.id} className="card" style={{ whiteSpace: 'pre-wrap' }}>
              {p.markdown}
            </pre>
          ))}
        </section>
      )}
    </>
  )
}

function DialogCard({ dialog, sessionId }: { dialog: InteractionPending; sessionId: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const resolve = async (body: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      // Settled is benign: the first answer won, wherever it came from.
      await post(`/api/sessions/${encodeURIComponent(sessionId)}/resolve`, body).catch(
        (err: unknown) => {
          if (!(err instanceof ApiError && err.code === 'settled')) throw err
        },
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: '0.6em' }}>
      {dialog.subject && <p className="muted mono">{dialog.subject}</p>}
      <p style={{ margin: '0.2em 0' }}>{dialog.prompt || `[${dialog.kind}]`}</p>
      {dialog.options?.map((opt, i) => (
        <button
          key={i}
          type="button"
          disabled={busy}
          onClick={() => void resolve({ dialogId: dialog.id, index: i })}
        >
          {opt}
        </button>
      ))}
      {dialog.text && !dialog.secret && (
        <TextAnswerForm busy={busy} onSend={(text) => resolve({ dialogId: dialog.id, text })} />
      )}
      <div style={{ marginTop: '0.4em' }}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void resolve({ dialogId: dialog.id, cancel: true })}
        >
          Cancel
        </button>
        {error && <span className="error-text"> {error}</span>}
      </div>
    </div>
  )
}

function TextAnswerForm({
  busy,
  onSend,
}: {
  busy: boolean
  onSend: (text: string) => void | Promise<void>
}) {
  const [text, setText] = useState('')
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault()
        if (text.trim() !== '') void onSend(text)
      }}
    >
      <input value={text} onChange={(ev) => setText(ev.target.value)} autoFocus />
      <button type="submit" disabled={busy || text.trim() === ''}>
        Answer
      </button>
    </form>
  )
}

function shortID(id: string): string {
  return id.length <= 10 ? id : id.slice(0, 8) + '…'
}
