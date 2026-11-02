package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Child is one row of the children table: an ajent process swarm spawned.
// ExitCode is nil while the child runs and negative when a signal ended it.
type Child struct {
	ID        int64
	PID       int
	SessionID string
	Workspace string
	Argv      string
	LogPath   string
	StartedAt time.Time
	ExitedAt  time.Time
	ExitCode  *int
	ExitNote  string
	LogTail   string
}

// CreateChild inserts one child row and returns its id.
func (s *Store) CreateChild(ctx context.Context, ch Child) (int64, error) {
	const q = `INSERT INTO children
        (pid, session_id, workspace, argv, log_path, started_at)
        VALUES (?, ?, ?, ?, ?, ?)`
	res, err := s.db.ExecContext(ctx, q,
		ch.PID, ch.SessionID, ch.Workspace, ch.Argv, ch.LogPath, unixSec(ch.StartedAt))
	if err != nil {
		return 0, fmt.Errorf("insert child: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("insert child: %w", err)
	}
	return id, nil
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
		ch.SessionID, ch.LogPath, unixSec(ch.ExitedAt), code, ch.ExitNote, ch.LogTail, ch.ID); err != nil {
		return fmt.Errorf("update child %d: %w", ch.ID, err)
	}
	return nil
}

// Children returns every child row, newest first.
func (s *Store) Children(ctx context.Context) ([]Child, error) {
	const q = `SELECT id, pid, session_id, workspace, argv, log_path,
        started_at, exited_at, exit_code, exit_note, log_tail
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
	if err := row.Scan(&ch.ID, &ch.PID, &ch.SessionID, &ch.Workspace, &ch.Argv, &ch.LogPath,
		&startedAt, &exitedAt, &exitCode, &ch.ExitNote, &ch.LogTail); err != nil {
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
