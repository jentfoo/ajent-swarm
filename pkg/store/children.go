package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// OriginSwarm is the children-table origin recorded for swarm-spawned
// processes; empty origins read as swarm, matching the column's legacy default.
const OriginSwarm = "swarm"

// Child is one row of the children table: a tracked ajent process, either
// swarm-spawned or external by Origin. ExitCode is nil while the process
// runs, negative when a signal ended it, and stays nil for externals, which
// swarm never reaps.
type Child struct {
	ID          int64
	PID         int
	SessionID   string
	SessionName string
	Workspace   string
	Argv        string
	LogPath     string
	StartedAt   time.Time
	ExitedAt    time.Time
	ExitCode    *int
	ExitNote    string
	LogTail     string
	Origin      string
}

// CreateChild inserts one child row and returns its id.
func (s *Store) CreateChild(ctx context.Context, ch Child) (int64, error) {
	if ch.Origin == "" {
		ch.Origin = OriginSwarm
	}
	const q = `INSERT INTO children
        (pid, session_id, session_name, workspace, argv, log_path, started_at, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	res, err := s.db.ExecContext(ctx, q,
		ch.PID, ch.SessionID, ch.SessionName, ch.Workspace, nullable(ch.Argv),
		nullable(ch.LogPath), unixSec(ch.StartedAt), ch.Origin)
	if err != nil {
		return 0, fmt.Errorf("insert child: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("insert child: %w", err)
	}
	return id, nil
}

// CreateChildIfAbsent inserts one child row unless its pid is already
// recorded, returning the row id and whether it inserted. Repeated discovery
// passes over the same process never duplicate a row.
func (s *Store) CreateChildIfAbsent(ctx context.Context, ch Child) (int64, bool, error) {
	if ch.Origin == "" {
		ch.Origin = OriginSwarm
	}
	const q = `INSERT INTO children
        (pid, session_id, session_name, workspace, argv, log_path, started_at, origin)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM children WHERE pid = ?)`
	res, err := s.db.ExecContext(ctx, q,
		ch.PID, ch.SessionID, ch.SessionName, ch.Workspace, nullable(ch.Argv),
		nullable(ch.LogPath), unixSec(ch.StartedAt), ch.Origin, ch.PID)
	if err != nil {
		return 0, false, fmt.Errorf("insert child: %w", err)
	}
	inserted, err := res.RowsAffected()
	if err != nil {
		return 0, false, fmt.Errorf("insert child: %w", err)
	}
	if inserted == 0 {
		var id int64
		if err = s.db.QueryRowContext(ctx,
			`SELECT id FROM children WHERE pid = ?`, ch.PID).Scan(&id); err != nil {
			return 0, false, fmt.Errorf("read child: %w", err)
		}
		return id, false, nil
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, false, fmt.Errorf("insert child: %w", err)
	}
	return id, true, nil
}

// UpdateChild writes the mutable columns of one child row, by id.
func (s *Store) UpdateChild(ctx context.Context, ch Child) error {
	const q = `UPDATE children SET
        session_id = ?, log_path = ?, exited_at = ?, exit_code = ?, exit_note = ?, log_tail = ?
        WHERE id = ?`
	var code any
	if ch.ExitCode != nil {
		code = *ch.ExitCode
	}
	if _, err := s.db.ExecContext(ctx, q,
		ch.SessionID, nullable(ch.LogPath), unixSec(ch.ExitedAt), code, ch.ExitNote, ch.LogTail,
		ch.ID); err != nil {
		return fmt.Errorf("update child %d: %w", ch.ID, err)
	}
	return nil
}

// DeleteChild removes one child row by id, an unknown id is already gone.
func (s *Store) DeleteChild(ctx context.Context, id int64) error {
	const q = `DELETE FROM children WHERE id = ?`
	if _, err := s.db.ExecContext(ctx, q, id); err != nil {
		return fmt.Errorf("delete child %d: %w", id, err)
	}
	return nil
}

// Children returns every child row, newest first.
func (s *Store) Children(ctx context.Context) ([]Child, error) {
	const q = `SELECT id, pid, session_id, session_name, workspace,
        COALESCE(argv, ''), COALESCE(log_path, ''),
        started_at, exited_at, exit_code, exit_note, log_tail, origin
        FROM children ORDER BY id DESC`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("read children: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Child
	for rows.Next() {
		ch, err := scanChild(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ch)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read children: %w", err)
	}
	return out, nil
}

// scanChild decodes one children row.
func scanChild(row interface{ Scan(...any) error }) (Child, error) {
	var (
		ch        Child
		startedAt int64
		exitedAt  int64
		exitCode  sql.NullInt64
	)
	if err := row.Scan(&ch.ID, &ch.PID, &ch.SessionID, &ch.SessionName, &ch.Workspace,
		&ch.Argv, &ch.LogPath, &startedAt, &exitedAt, &exitCode, &ch.ExitNote, &ch.LogTail,
		&ch.Origin); err != nil {
		return Child{}, fmt.Errorf("scan child: %w", err)
	}
	ch.StartedAt = fromUnixSec(startedAt)
	ch.ExitedAt = fromUnixSec(exitedAt)
	if exitCode.Valid {
		code := int(exitCode.Int64)
		ch.ExitCode = &code
	}
	return ch, nil
}

// nullable stores an empty string as NULL, since external children have no
// argv or log path to record.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
