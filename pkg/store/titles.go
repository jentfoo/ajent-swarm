package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// maxTitleRunes bounds one stored display title; labels render in tight rows,
// so a giant one would only be clipped everywhere.
const maxTitleRunes = 120

// SetSessionTitle writes one display title for a session, upserting by id. An
// empty or whitespace-only title clears the row.
func (s *Store) SetSessionTitle(ctx context.Context, sessionID, title string) error {
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("session id must not be empty")
	}
	title = strings.TrimSpace(clipRunes(title, maxTitleRunes))
	if title == "" {
		_, err := s.db.ExecContext(ctx, `DELETE FROM session_titles WHERE session_id = ?`, sessionID)
		if err != nil {
			return fmt.Errorf("delete session title: %w", err)
		}
		return nil
	}

	const q = `INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
	if _, err := s.db.ExecContext(ctx, q, sessionID, title, time.Now().Unix()); err != nil {
		return fmt.Errorf("upsert session title: %w", err)
	}
	return nil
}

// SessionTitles returns every stored display title keyed by session id. A
// missing table row simply means no title; the map is empty when none exist.
func (s *Store) SessionTitles(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT session_id, title FROM session_titles`)
	if err != nil {
		return nil, fmt.Errorf("read session titles: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := make(map[string]string)
	for rows.Next() {
		var id, title string
		if err = rows.Scan(&id, &title); err != nil {
			return nil, fmt.Errorf("scan session title: %w", err)
		}
		out[id] = title
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read session titles: %w", err)
	}
	return out, nil
}

// clipRunes bounds s to at most n runes.
func clipRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
