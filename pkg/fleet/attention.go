package fleet

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"
)

// Attention kinds carried by the digest, one per live session row. The
// derivation below is the one transcription of the rules, clients render the
// kind, reason and wait verbatim instead of re-deriving them.
const (
	AttentionNeedsInput  = "needs-input"  // an open dialog wants an answer
	AttentionNeedsReview = "needs-review" // an idle session after an unacknowledged turn end
	AttentionAwaiting    = "awaiting"     // an idle agent waiting for its next prompt
	AttentionWorking     = "working"      // a turn is live or a spinner is up
)

// ErrNoAckStore reports an acknowledgment against a manager started without a
// store, which cannot settle attention for every device.
var ErrNoAckStore = errors.New("no attention ack store configured")

// AckStore persists attention acknowledgments, so one device's check-off
// settles the row for every device and survives restarts. Shared-inbox
// semantics: single-user service, no per-viewer scoping.
type AckStore interface {
	// AckDialog settles one dialog, keyed by session plus pid so twin
	// instances and restarted processes never settle each other's dialogs.
	AckDialog(ctx context.Context, sessionID string, pid int, dialogID uint64, at time.Time) error
	// AckTurn advances one session's acknowledged turn-end watermark, the
	// stored value only ever moves forward.
	AckTurn(ctx context.Context, sessionID string, turnEnd int64, at time.Time) error
	// DialogAcks returns every stored dialog acknowledgment.
	DialogAcks(ctx context.Context) ([]DialogAck, error)
	// TurnAcks returns every session's acknowledged turn-end watermark keyed
	// by session id.
	TurnAcks(ctx context.Context) (map[string]int64, error)
}

// DialogAck is one stored dialog acknowledgment row.
type DialogAck struct {
	SessionID string
	PID       int
	DialogID  uint64
	AckedAt   int64 // unix milliseconds
}

// dialogAckKey names one dialog acknowledgment: twin instances share a session
// id and are told apart by pid, matching the digest rows clients see.
type dialogAckKey struct {
	sessionID string
	pid       int
	dialogID  uint64
}

// loadAcks seeds the acknowledgment cache from the manager's store. Failures
// log once and leave the cache empty: every item reads unacknowledged until a
// write-through lands, so nothing settles silently wrong.
func (m *Manager) loadAcks(ctx context.Context) {
	wctx, cancel := context.WithTimeout(ctx, storeWriteWait)
	defer cancel()
	dialogs, err := m.ackStore.DialogAcks(wctx)
	if err != nil {
		m.log.Warn("reading attention acks failed", "err", err)
		return
	}
	turns, err := m.ackStore.TurnAcks(wctx)
	if err != nil {
		m.log.Warn("reading attention acks failed", "err", err)
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.dialogAcks = make(map[dialogAckKey]struct{}, len(dialogs))
	for _, d := range dialogs {
		m.dialogAcks[dialogAckKey{d.SessionID, d.PID, d.DialogID}] = struct{}{}
	}
	m.turnAcks = turns
}

// AckDialog settles one dialog's attention row everywhere: the store keeps the
// acknowledgment across restarts, and the cache feeds the next digest.
func (m *Manager) AckDialog(ctx context.Context, sessionID string, pid int, dialogID uint64) error {
	if strings.TrimSpace(sessionID) == "" {
		return ErrUnknownSession
	}
	if dialogID == 0 {
		return errors.New("dialog id must not be zero")
	}
	if m.ackStore == nil {
		return ErrNoAckStore
	}

	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storeWriteWait)
	defer cancel()
	if err := m.ackStore.AckDialog(wctx, sessionID, pid, dialogID, time.Now()); err != nil {
		return err
	}
	m.mu.Lock()
	m.dialogAcks[dialogAckKey{sessionID, pid, dialogID}] = struct{}{}
	m.mu.Unlock()
	return nil
}

// AckTurn settles the session's attention through turnEnd: acting later than
// an older turn end covers it too, so the watermark only ever moves forward.
func (m *Manager) AckTurn(ctx context.Context, sessionID string, turnEnd int64) error {
	if strings.TrimSpace(sessionID) == "" {
		return ErrUnknownSession
	}
	if turnEnd <= 0 {
		return errors.New("turn end must be positive")
	}
	if m.ackStore == nil {
		return ErrNoAckStore
	}

	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storeWriteWait)
	defer cancel()
	if err := m.ackStore.AckTurn(wctx, sessionID, turnEnd, time.Now()); err != nil {
		return err
	}
	m.mu.Lock()
	if turnEnd > m.turnAcks[sessionID] { // concurrent acks never move backward
		m.turnAcks[sessionID] = turnEnd
	}
	m.mu.Unlock()
	return nil
}

// ackFacts carries one digest row's folded acknowledgment state.
type ackFacts struct {
	dialog bool  // the row's oldest open dialog is settled
	turn   int64 // the session's acknowledged turn-end watermark
}

// ackFactsFor reads every serving row's ack facts under one lock hold.
func (m *Manager) ackFactsFor(statuses []*Status) []ackFacts {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]ackFacts, len(statuses))
	for i, st := range statuses {
		_, out[i].dialog = m.dialogAcks[dialogAckKey{st.SessionID, st.PID, st.DialogID}]
		out[i].turn = m.turnAcks[st.SessionID]
	}
	return out
}

// deriveAttention folds one serving row and its ack facts into a digest row.
// Needs input beats a parked prompt (the dialog blocks the flush), a parked
// session works while it waits out its quiet window, then an idle agent
// awaits its next prompt, and only busy sessions work. The digest names only
// the oldest open dialog, so a session with that one acknowledged still shows
// a generic count while further dialogs wait.
func deriveAttention(st *Status, acks ackFacts) Attention {
	row := Attention{
		digestFacts: st.digestFacts,
		// Acknowledgment facts from the server-side ledger: whether this row's
		// oldest open dialog is settled, and the session's acknowledged turn end.
		AckedDialog: acks.dialog,
		AckedTurn:   acks.turn,
	}

	if st.OpenInteractions > 0 {
		unacked := st.OpenInteractions
		if acks.dialog {
			unacked--
		}
		if unacked > 0 {
			row.Kind = AttentionNeedsInput
			row.Since = st.DialogAt
			prompt := strings.TrimSpace(st.DialogPrompt)
			if acks.dialog || prompt == "" {
				row.Reason = strconv.Itoa(unacked) + " more dialog(s) open"
			} else {
				row.Reason = prompt
			}
			return row
		}
	}

	busy := st.Running || st.Spinning
	if st.Parked > 0 {
		row.Kind = AttentionWorking
		row.Since = st.ParkedAt
		switch {
		case busy && strings.TrimSpace(st.Activity) != "":
			row.Reason = st.Activity
		case st.Parked > 1:
			row.Reason = strconv.Itoa(st.Parked) + " prompts queued for idle"
		case st.ParkedPrompt != "":
			row.Reason = "queued: " + st.ParkedPrompt
		default:
			row.Reason = "prompt queued for idle"
		}
		return row
	}

	if !busy && st.LastTurnEnd > 0 && st.LastTurnEnd > acks.turn {
		row.Kind = AttentionNeedsReview
		row.Reason = stopReasonText(st.LastStop, st.LastStopErr)
		row.Since = st.LastTurnEnd
		return row
	}

	if !busy {
		row.Kind = AttentionAwaiting
		if reason := strings.TrimSpace(st.Activity); reason != "" {
			row.Reason = reason
		} else {
			row.Reason = "waiting for a prompt"
		}
		return row
	}

	row.Kind = AttentionWorking
	row.Reason = st.Activity
	return row
}

// stopReasonText renders one turn end as the digest's one-line reason. Mirrors
// describeStop in web/src/workspace/attention.ts, keep them in step.
func stopReasonText(stop, stopErr string) string {
	if stopErr != "" {
		return "turn failed"
	}
	switch stop {
	case "end_turn":
		return "turn complete"
	case "max_tokens":
		return "stopped: max tokens"
	case "aborted":
		return "turn interrupted"
	case "tool_use", "incomplete":
		return "turn paused unfinished"
	case "error":
		return "turn failed"
	case "", "unknown":
		return "turn finished"
	default:
		return "stopped: " + stop
	}
}
