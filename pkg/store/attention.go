package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// maxDialogAcksPerSession bounds one session's dialog acknowledgments, newest
// kept, mirroring the client ledger this store replaces: an unbounded history
// would only ever cover dialogs long resolved.
const maxDialogAcksPerSession = 50

// DialogAck is one settled dialog row: the acknowledgment a check-off or an
// answer records, keyed by session plus pid so twin instances and restarted
// processes never settle each other's dialogs.
type DialogAck struct {
	SessionID string
	PID       int
	DialogID  uint64
	AckedAt   int64 // unix milliseconds
}

// AckDialog records one dialog as acknowledged and prunes the session's oldest
// rows past the per-session bound. Re-acking an existing row only refreshes it.
func (s *Store) AckDialog(ctx context.Context,
	sessionID string, pid int, dialogID uint64, at time.Time,
) error {
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("session id must not be empty")
	}
	if dialogID == 0 {
		return errors.New("dialog id must not be zero")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("ack dialog: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err = tx.ExecContext(ctx, `INSERT INTO attention_dialog_acks
	        (session_id, pid, dialog_id, acked_at) VALUES (?, ?, ?, ?)
	        ON CONFLICT(session_id, pid, dialog_id)
	        DO UPDATE SET acked_at = excluded.acked_at`,
		sessionID, pid, dialogID, unixMilli(at)); err != nil {
		return fmt.Errorf("ack dialog: %w", err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM attention_dialog_acks
	    WHERE session_id = ? AND rowid IN (
	        SELECT rowid FROM attention_dialog_acks WHERE session_id = ?
	        ORDER BY acked_at DESC, pid DESC, dialog_id DESC
	        LIMIT -1 OFFSET ?)`,
		sessionID, sessionID, maxDialogAcksPerSession); err != nil {
		return fmt.Errorf("ack dialog: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("ack dialog: %w", err)
	}
	return nil
}

// AckTurn advances one session's acknowledged turn-end watermark. The value
// only ever moves forward: acting later than an older turn end covers it too.
func (s *Store) AckTurn(ctx context.Context, sessionID string, turnEnd int64, at time.Time) error {
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("session id must not be empty")
	}
	if turnEnd <= 0 {
		return errors.New("turn end must be positive")
	}

	if _, err := s.db.ExecContext(ctx, `INSERT INTO attention_turn_acks
	    (session_id, turn_end, acked_at) VALUES (?, ?, ?)
	    ON CONFLICT(session_id) DO UPDATE SET
	        turn_end = excluded.turn_end, acked_at = excluded.acked_at
	    WHERE excluded.turn_end > attention_turn_acks.turn_end`,
		sessionID, turnEnd, unixMilli(at)); err != nil {
		return fmt.Errorf("ack turn: %w", err)
	}
	return nil
}

// DialogAcks returns every stored dialog acknowledgment.
func (s *Store) DialogAcks(ctx context.Context) ([]DialogAck, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT session_id, pid, dialog_id, acked_at FROM attention_dialog_acks`)
	if err != nil {
		return nil, fmt.Errorf("read dialog acks: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := make([]DialogAck, 0)
	for rows.Next() {
		var r DialogAck
		if err = rows.Scan(&r.SessionID, &r.PID, &r.DialogID, &r.AckedAt); err != nil {
			return nil, fmt.Errorf("scan dialog ack: %w", err)
		}
		out = append(out, r)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read dialog acks: %w", err)
	}
	return out, nil
}

// TurnAcks returns every session's acknowledged turn-end watermark keyed by
// session id, a missing row simply means nothing was acknowledged yet.
func (s *Store) TurnAcks(ctx context.Context) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT session_id, turn_end FROM attention_turn_acks`)
	if err != nil {
		return nil, fmt.Errorf("read turn acks: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := make(map[string]int64)
	for rows.Next() {
		var (
			id      string
			turnEnd int64
		)
		if err = rows.Scan(&id, &turnEnd); err != nil {
			return nil, fmt.Errorf("scan turn ack: %w", err)
		}
		out[id] = turnEnd
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read turn acks: %w", err)
	}
	return out, nil
}
