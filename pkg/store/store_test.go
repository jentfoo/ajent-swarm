package store

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestStore opens a throwaway database in an isolated temp directory.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestOpen(t *testing.T) {
	t.Parallel()

	t.Run("migrations_apply_twice", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), FileName)
		first, err := Open(path)
		require.NoError(t, err)
		t.Cleanup(func() { _ = first.Close() })

		reopened, err := Open(path)
		require.NoError(t, err)
		t.Cleanup(func() { _ = reopened.Close() })

		var count int
		require.NoError(t, reopened.db.QueryRowContext(
			t.Context(), `SELECT COUNT(*) FROM schema_migrations`).Scan(&count))
		assert.Equal(t, len(readMigrations()), count)

		_, err = reopened.db.ExecContext(t.Context(), `SELECT 1 FROM users`)
		assert.NoError(t, err)
	})

	t.Run("writes_survive_reopen", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), FileName)
		first, err := Open(path)
		require.NoError(t, err)
		ctx := t.Context()
		require.NoError(t, first.UpsertUserPassword(ctx, "jent", "$2a$12$hash"))
		require.NoError(t, first.Close())

		reopened, err := Open(path)
		require.NoError(t, err)
		t.Cleanup(func() { _ = reopened.Close() })

		u, err := reopened.User(ctx, "jent")
		require.NoError(t, err)
		assert.Equal(t, "$2a$12$hash", u.PasswordHash)
	})
}
