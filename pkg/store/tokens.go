package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// APIToken is one row of the api_tokens table. Only each token's sha256 hash
// is stored, never its plaintext secret.
type APIToken struct {
	Name      string
	TokenHash string
	CreatedAt time.Time
	LastUsed  time.Time // zero when the token was never used
}

// CreateAPIToken inserts a new token row; a duplicate name or hash reports
// ErrConflict.
func (s *Store) CreateAPIToken(ctx context.Context, tok APIToken) error {
	const q = `INSERT INTO api_tokens (name, token_hash, created_at, last_used_at)
        VALUES (?, ?, ?, ?)`
	_, err := s.db.ExecContext(ctx, q,
		tok.Name, tok.TokenHash, unixSec(tok.CreatedAt), unixSec(tok.LastUsed))
	if isUniqueViolation(err) {
		return fmt.Errorf("%w: api token %q", ErrConflict, tok.Name)
	} else if err != nil {
		return fmt.Errorf("insert api token: %w", err)
	}
	return nil
}

// Tokens lists every API token in creation order.
func (s *Store) Tokens(ctx context.Context) ([]APIToken, error) {
	const q = `SELECT name, token_hash, created_at, last_used_at FROM api_tokens ORDER BY id`
	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("list api tokens: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var out []APIToken
	for rows.Next() {
		var tok APIToken
		var createdAt, lastUsedAt int64
		if err = rows.Scan(&tok.Name, &tok.TokenHash, &createdAt, &lastUsedAt); err != nil {
			return nil, fmt.Errorf("list api tokens: %w", err)
		}
		tok.CreatedAt = fromUnixSec(createdAt)
		tok.LastUsed = fromUnixSec(lastUsedAt)
		out = append(out, tok)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("list api tokens: %w", err)
	}
	return out, nil
}

// APITokenByHash returns one token by its stored hash.
func (s *Store) APITokenByHash(ctx context.Context, hash string) (APIToken, error) {
	const q = `SELECT name, token_hash, created_at, last_used_at FROM api_tokens WHERE token_hash = ?`
	var tok APIToken
	var createdAt, lastUsedAt int64
	err := s.db.QueryRowContext(ctx, q, hash).Scan(&tok.Name, &tok.TokenHash, &createdAt, &lastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return APIToken{}, ErrNotFound
	} else if err != nil {
		return APIToken{}, fmt.Errorf("read api token: %w", err)
	}
	tok.CreatedAt = fromUnixSec(createdAt)
	tok.LastUsed = fromUnixSec(lastUsedAt)
	return tok, nil
}

// TouchTokenUsage records the latest use of one token.
func (s *Store) TouchTokenUsage(ctx context.Context, hash string, at time.Time) error {
	const q = `UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`
	if _, err := s.db.ExecContext(ctx, q, unixSec(at), hash); err != nil {
		return fmt.Errorf("touch api token: %w", err)
	}
	return nil
}

// DeleteAPIToken removes one token by name and reports whether a row was
// removed.
func (s *Store) DeleteAPIToken(ctx context.Context, name string) (bool, error) {
	const q = `DELETE FROM api_tokens WHERE name = ?`
	res, err := s.db.ExecContext(ctx, q, name)
	if err != nil {
		return false, fmt.Errorf("delete api token: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete api token: %w", err)
	}
	return n > 0, nil
}

// isUniqueViolation matches the modernc driver's constraint-failure message,
// which carries no typed error code across database/sql.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}
