package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMigrate(t *testing.T) {
	t.Parallel()

	t.Run("fresh_database", func(t *testing.T) {
		st := newTestStore(t)

		tables, err := tableNames(t, st)
		require.NoError(t, err)
		for _, want := range []string{
			"users", "auth_sessions", "api_tokens",
			"children", "jobs", "runs",
			"session_titles", "app_settings", "recall_lines",
			"attention_dialog_acks", "attention_turn_acks",
		} {
			assert.Contains(t, tables, want)
		}
	})

	t.Run("pre_release_upgrade", func(t *testing.T) {
		// a database migrated by a pre-collapse build records the old version
		// range; Open sees the baseline as already applied, skips every file and
		// leaves working state untouched
		path := filepath.Join(t.TempDir(), FileName)
		db, err := sql.Open("sqlite", "file:"+path)
		require.NoError(t, err)
		ctx := t.Context()
		_, err = db.ExecContext(ctx, `CREATE TABLE schema_migrations (
		    version INTEGER PRIMARY KEY,
		    applied_at INTEGER NOT NULL)`)
		require.NoError(t, err)
		for version := 1; version <= 11; version++ {
			_, err = db.ExecContext(ctx,
				`INSERT INTO schema_migrations (version, applied_at) VALUES (?, 0)`, version)
			require.NoError(t, err)
		}
		_, err = db.ExecContext(ctx, `CREATE TABLE users (
		    username TEXT PRIMARY KEY, password_hash TEXT NOT NULL DEFAULT '')`)
		require.NoError(t, err)
		_, err = db.ExecContext(ctx,
			`INSERT INTO users (username, password_hash) VALUES ('jent', '$2a$12$hash')`)
		require.NoError(t, err)
		require.NoError(t, db.Close())

		st, err := Open(path)
		require.NoError(t, err)
		t.Cleanup(func() { _ = st.Close() })

		rows, err := st.db.QueryContext(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
		require.NoError(t, err)
		var versions []int
		for rows.Next() {
			var version int
			require.NoError(t, rows.Scan(&version))
			versions = append(versions, version)
		}
		require.NoError(t, rows.Err())
		assert.Equal(t, []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}, versions)

		u, err := st.User(ctx, "jent")
		require.NoError(t, err)
		assert.Equal(t, "$2a$12$hash", u.PasswordHash) // rows survive the skipped baseline
	})
}

// tableNames lists every table in the store's database.
func tableNames(t *testing.T, s *Store) ([]string, error) {
	t.Helper()
	rows, err := s.db.QueryContext(t.Context(),
		`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var names []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}
