package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// AuthSession is one row of the auth_sessions table. Only the token's sha256
// hash is stored, never the raw cookie value.
type AuthSession struct {
	TokenHash string
	CreatedAt time.Time
	LastSeen  time.Time
	ExpiresAt time.Time
}

// CreateAuthSession inserts a new session row.
func (s *Store) CreateAuthSession(ctx context.Context, sess AuthSession) error {
	const q = `INSERT INTO auth_sessions (token_hash, created_at, last_seen_at, expires_at)
        VALUES (?, ?, ?, ?)`
	_, err := s.db.ExecContext(ctx, q,
		sess.TokenHash, unixSec(sess.CreatedAt), unixSec(sess.LastSeen), unixSec(sess.ExpiresAt))
	if err != nil {
		return fmt.Errorf("insert auth session: %w", err)
	}
	return nil
}

// AuthSessionByHash returns one session by token hash.
func (s *Store) AuthSessionByHash(ctx context.Context, hash string) (AuthSession, error) {
	const q = `SELECT token_hash, created_at, last_seen_at, expires_at
        FROM auth_sessions WHERE token_hash = ?`
	var sess AuthSession
	var createdAt, lastSeenAt, expiresAt int64
	err := s.db.QueryRowContext(ctx, q, hash).Scan(&sess.TokenHash, &createdAt, &lastSeenAt, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthSession{}, ErrNotFound
	} else if err != nil {
		return AuthSession{}, fmt.Errorf("read auth session: %w", err)
	}
	sess.CreatedAt = fromUnixSec(createdAt)
	sess.LastSeen = fromUnixSec(lastSeenAt)
	sess.ExpiresAt = fromUnixSec(expiresAt)
	return sess, nil
}

// TouchAuthSession refreshes one session's sliding window.
func (s *Store) TouchAuthSession(ctx context.Context, hash string, lastSeen, expiresAt time.Time) error {
	const q = `UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?`
	if _, err := s.db.ExecContext(ctx, q, unixSec(lastSeen), unixSec(expiresAt), hash); err != nil {
		return fmt.Errorf("touch auth session: %w", err)
	}
	return nil
}

// DeleteAuthSession removes one session row.
func (s *Store) DeleteAuthSession(ctx context.Context, hash string) error {
	const q = `DELETE FROM auth_sessions WHERE token_hash = ?`
	if _, err := s.db.ExecContext(ctx, q, hash); err != nil {
		return fmt.Errorf("delete auth session: %w", err)
	}
	return nil
}

// DeleteExpiredSessions removes every expired session and reports the count.
func (s *Store) DeleteExpiredSessions(ctx context.Context, now time.Time) (int64, error) {
	const q = `DELETE FROM auth_sessions WHERE expires_at < ?`
	res, err := s.db.ExecContext(ctx, q, unixSec(now))
	if err != nil {
		return 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	return n, nil
}

// unixSec converts a time to stored unix seconds, the zero time stores as 0.
func unixSec(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.Unix()
}

// fromUnixSec restores a time from stored unix seconds.
func fromUnixSec(sec int64) time.Time {
	if sec == 0 {
		return time.Time{}
	}
	return time.Unix(sec, 0)
}
