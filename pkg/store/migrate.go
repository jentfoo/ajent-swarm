package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"slices"
	"strconv"
	"strings"
	"time"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// migration is one versioned step of the schema.
type migration struct {
	version int
	name    string
	sql     string
}

// readMigrations loads the embedded SQL files, ordered by version.
func readMigrations() []migration {
	entries, err := fs.ReadDir(migrationsFS, "migrations")
	if err != nil {
		panic("store: embedded migrations missing: " + err.Error())
	}
	out := make([]migration, 0, len(entries))
	for _, e := range entries {
		m, err := parseMigration(e.Name())
		if err != nil {
			panic("store: " + err.Error())
		}
		out = append(out, m)
	}
	slices.SortFunc(out, func(a, b migration) int { return a.version - b.version })
	return out
}

// parseMigration reads one numbered SQL file, e.g. 0001_init.sql.
func parseMigration(name string) (migration, error) {
	versionStr, rest, ok := strings.Cut(strings.TrimSuffix(name, ".sql"), "_")
	if !ok {
		return migration{}, fmt.Errorf("migration %s: missing version prefix", name)
	}
	version, err := strconv.Atoi(versionStr)
	if err != nil {
		return migration{}, fmt.Errorf("migration %s: bad version %q", name, versionStr)
	}
	body, err := migrationsFS.ReadFile("migrations/" + name)
	if err != nil {
		return migration{}, fmt.Errorf("migration %s: %w", name, err)
	}
	return migration{version: version, name: rest, sql: string(body)}, nil
}

// migrate creates the bookkeeping table and applies every pending migration,
// each in its own transaction.
func (s *Store) migrate() error {
	ctx := context.Background()
	const createBookkeeping = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL)`
	if _, err := s.db.ExecContext(ctx, createBookkeeping); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read applied migrations: %w", err)
	}
	defer func() { _ = rows.Close() }()

	applied := make(map[int]struct{})
	for rows.Next() {
		var version int
		if err = rows.Scan(&version); err != nil {
			return fmt.Errorf("scan schema_migrations: %w", err)
		}
		applied[version] = struct{}{}
	}
	if err = rows.Err(); err != nil {
		return fmt.Errorf("read applied migrations: %w", err)
	}

	for _, m := range readMigrations() {
		if _, ok := applied[m.version]; ok {
			continue
		}
		if err = s.applyMigration(ctx, m); err != nil {
			return err
		}
	}
	return nil
}

// applyMigration runs one migration and records its version atomically.
func (s *Store) applyMigration(ctx context.Context, m migration) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("migration %04d_%s: %w", m.version, m.name, err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err = tx.ExecContext(ctx, m.sql); err != nil {
		return fmt.Errorf("migration %04d_%s: %w", m.version, m.name, err)
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		m.version, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("migration %04d_%s: record version: %w", m.version, m.name, err)
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("migration %04d_%s: commit: %w", m.version, m.name, err)
	}
	return nil
}
