package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// User is one row of the users table.
type User struct {
	Username     string
	PasswordHash string // empty until bootstrap or --password sets one
}

// UpsertUserPassword inserts the user or overwrites its password hash.
func (s *Store) UpsertUserPassword(ctx context.Context, username, hash string) error {
	const q = `INSERT INTO users (username, password_hash) VALUES (?, ?)
        ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`
	if _, err := s.db.ExecContext(ctx, q, username, hash); err != nil {
		return fmt.Errorf("upsert user: %w", err)
	}
	return nil
}

// User returns one user by name.
func (s *Store) User(ctx context.Context, username string) (User, error) {
	const q = `SELECT username, password_hash FROM users WHERE username = ?`
	var u User
	err := s.db.QueryRowContext(ctx, q, username).Scan(&u.Username, &u.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	} else if err != nil {
		return User{}, fmt.Errorf("read user: %w", err)
	}
	return u, nil
}

// SoleUser returns the only users row; flows here keep at most one.
func (s *Store) SoleUser(ctx context.Context) (User, error) {
	const q = `SELECT username, password_hash FROM users ORDER BY username LIMIT 1`
	var u User
	err := s.db.QueryRowContext(ctx, q).Scan(&u.Username, &u.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	} else if err != nil {
		return User{}, fmt.Errorf("read sole user: %w", err)
	}
	return u, nil
}

// HasUsableCredential reports whether any user row carries a password hash.
func (s *Store) HasUsableCredential(ctx context.Context) (bool, error) {
	const q = `SELECT EXISTS(SELECT 1 FROM users WHERE password_hash <> '')`
	var exists bool
	if err := s.db.QueryRowContext(ctx, q).Scan(&exists); err != nil {
		return false, fmt.Errorf("read credential state: %w", err)
	}
	return exists, nil
}
