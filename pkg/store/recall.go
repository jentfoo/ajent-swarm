package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// maxRecallLines caps one workspace's stored recall rows, newest kept,
// mirroring ajent's own editor-history bound.
const maxRecallLines = 1000

// RecallLine is one row of the recall_lines table: a submitted typed prompt
// recorded for its workspace's recall scope. Text is empty for a withheld
// row, one whose content the upstream secret discipline refuses to store.
type RecallLine struct {
	ID        int64
	Workspace string
	Text      string
	CreatedAt time.Time
}

// RecordRecallLine appends one submitted line to its workspace's recall rows
// and returns the row id. A repeat of the newest row folds into it, moving
// that row to the newest position, and the workspace keeps at most
// maxRecallLines rows.
func (s *Store) RecordRecallLine(ctx context.Context, workspace, text string, at time.Time) (int64, error) {
	if strings.TrimSpace(workspace) == "" {
		return 0, errors.New("workspace must not be empty")
	}
	text = strings.TrimRight(text, "\r") // upstream's append rule, so recall round-trips

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("record recall line: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var (
		id     int64
		newest string
	)
	rowErr := tx.QueryRowContext(ctx,
		`SELECT id, text FROM recall_lines WHERE workspace = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`, workspace,
	).Scan(&id, &newest)
	isRepeat := false
	switch {
	case errors.Is(rowErr, sql.ErrNoRows): // first row for the workspace
	case rowErr != nil:
		return 0, fmt.Errorf("record recall line: %w", rowErr)
	default:
		isRepeat = newest == text // consecutive repeat: newest wins, no duplicate
	}

	if isRepeat {
		if _, err = tx.ExecContext(ctx,
			`UPDATE recall_lines SET created_at = ? WHERE id = ?`, unixMilli(at), id); err != nil {
			return 0, fmt.Errorf("record recall line: %w", err)
		}
	} else if id, err = insertRecallLineTx(ctx, tx, workspace, text, at); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, fmt.Errorf("record recall line: %w", err)
	}
	return id, nil
}

// insertRecallLineTx appends one row and prunes its workspace past the cap.
// tx must be live.
func insertRecallLineTx(ctx context.Context, tx *sql.Tx,
	workspace, text string, at time.Time,
) (int64, error) {
	res, err := tx.ExecContext(ctx,
		`INSERT INTO recall_lines (workspace, text, created_at) VALUES (?, ?, ?)`,
		workspace, text, unixMilli(at))
	if err != nil {
		return 0, fmt.Errorf("insert recall line: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("insert recall line: %w", err)
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM recall_lines WHERE workspace = ? AND id NOT IN (
		SELECT id FROM recall_lines WHERE workspace = ?
		ORDER BY created_at DESC, id DESC LIMIT ?)`,
		workspace, workspace, maxRecallLines); err != nil {
		return 0, fmt.Errorf("insert recall line: %w", err)
	}
	return id, nil
}

// ScrubRecallLine withholds one row's text, keeping its id resolvable: the
// committed facts refused the content, so recall never offers it again. An
// unknown id reports ErrNotFound.
func (s *Store) ScrubRecallLine(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `UPDATE recall_lines SET text = '' WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("scrub recall line %d: %w", id, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// RecallLines returns up to limit distinct submitted lines for a workspace,
// newest first. Each text appears once at its newest occurrence and withheld
// rows never surface. Query narrows by case-insensitive substring, empty
// matching everything.
func (s *Store) RecallLines(ctx context.Context, workspace, query string, limit int) ([]RecallLine, error) {
	if strings.TrimSpace(workspace) == "" {
		return nil, errors.New("workspace must not be empty")
	}
	limit = min(max(limit, 1), maxRecallLines)
	rows, err := s.db.QueryContext(ctx, `SELECT id, workspace, text, created_at
	    FROM recall_lines WHERE workspace = ? ORDER BY created_at DESC, id DESC`, workspace)
	if err != nil {
		return nil, fmt.Errorf("read recall lines: %w", err)
	}
	defer func() { _ = rows.Close() }()

	q := strings.ToLower(query)
	seen := make(map[string]struct{})
	out := make([]RecallLine, 0)
	for rows.Next() {
		var (
			r      RecallLine
			thenMS int64
		)
		if err = rows.Scan(&r.ID, &r.Workspace, &r.Text, &thenMS); err != nil {
			return nil, fmt.Errorf("scan recall line: %w", err)
		}
		r.CreatedAt = fromUnixMilli(thenMS)
		if r.Text == "" { // withheld: the id keeps resolving, the text never shows
			continue
		}
		if _, dup := seen[r.Text]; dup || !strings.Contains(strings.ToLower(r.Text), q) {
			continue
		}
		seen[r.Text] = struct{}{}
		out = append(out, r)
		if len(out) == limit {
			break
		}
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read recall lines: %w", err)
	}
	return out, nil
}
