// Package store persists ajent-swarm state in SQLite under the state
// directory: users, auth sessions, API tokens, jobs and run history.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

// FileName is the database file created inside the state directory.
const FileName = "swarm.db"

// ErrNotFound reports a query that matched no rows.
var ErrNotFound = errors.New("not found")

// ErrConflict reports an insert that violates a uniqueness constraint.
var ErrConflict = errors.New("conflict")

// Store is the SQLite-backed state store. All access serializes through one
// connection handle: the service is single-user scale, so throughput is a
// non-issue and one handle rules out self-inflicted SQLITE_BUSY entirely.
type Store struct {
	db *sql.DB
}

// Open opens or creates the database at path and applies pending migrations.
func Open(path string) (*Store, error) {
	// pragmas ride the DSN so fresh connections inherit them, WAL persists in
	// the file and busy_timeout covers external readers of it
	dsn := "file:" + path +
		"?_pragma=busy_timeout(5000)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err = db.PingContext(context.Background()); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	s := &Store{db: db}
	if err = s.migrate(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate %s: %w", path, err)
	}
	return s, nil
}

// Close releases the database handle.
func (s *Store) Close() error {
	return s.db.Close()
}
