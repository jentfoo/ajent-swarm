package store

import (
	"context"
	"fmt"
)

// Chain is one row of the chains table: a parent-to-child handoff and its
// lifecycle state, mirroring fleet's wire record. Timestamps are unix
// milliseconds, matching run rows.
type Chain struct {
	ID          string
	ParentID    string
	ChildID     string
	FinalPrompt string
	ChildPrompt string
	PendingID   string
	FinalAt     int64 // unix ms the final submit landed, 0 when it never ran
	State       string
	Reason      string
	Mark        string // the final prompt's committed entry id
	CreatedAt   int64  // unix milliseconds
	UpdatedAt   int64  // unix milliseconds
}

// SaveChain upserts one chain row by id.
func (s *Store) SaveChain(ctx context.Context, ch Chain) error {
	const q = `INSERT INTO chains
        (id, parent_id, child_id, final_prompt, child_prompt, pending_id, state, reason,
         mark, final_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            parent_id = excluded.parent_id,
            child_id = excluded.child_id,
            final_prompt = excluded.final_prompt,
            child_prompt = excluded.child_prompt,
            pending_id = excluded.pending_id,
            state = excluded.state,
            reason = excluded.reason,
            mark = excluded.mark,
            final_at = excluded.final_at,
            updated_at = excluded.updated_at`
	if _, err := s.db.ExecContext(ctx, q, ch.ID, ch.ParentID, ch.ChildID, ch.FinalPrompt,
		ch.ChildPrompt, ch.PendingID, ch.State, ch.Reason, ch.Mark, ch.FinalAt,
		ch.CreatedAt, ch.UpdatedAt); err != nil {
		return fmt.Errorf("save chain %s: %w", ch.ID, err)
	}
	return nil
}

// DeleteChain removes one chain row by id, an unknown id is already gone.
func (s *Store) DeleteChain(ctx context.Context, id string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM chains WHERE id = ?`, id); err != nil {
		return fmt.Errorf("delete chain %s: %w", id, err)
	}
	return nil
}

// LoadChains returns every chain row, oldest first.
func (s *Store) LoadChains(ctx context.Context) ([]Chain, error) {
	const q = `SELECT id, parent_id, child_id, final_prompt, child_prompt, pending_id,
        state, reason, mark, final_at, created_at, updated_at
        FROM chains ORDER BY created_at, id`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("read chains: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []Chain
	for rows.Next() {
		var ch Chain
		if err = rows.Scan(&ch.ID, &ch.ParentID, &ch.ChildID, &ch.FinalPrompt, &ch.ChildPrompt,
			&ch.PendingID, &ch.State, &ch.Reason, &ch.Mark, &ch.FinalAt, &ch.CreatedAt,
			&ch.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan chain: %w", err)
		}
		out = append(out, ch)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("read chains: %w", err)
	}
	return out, nil
}
