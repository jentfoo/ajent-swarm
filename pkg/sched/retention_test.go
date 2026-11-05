package sched

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// quietLogger drops everything, keeping sweep output out of test logs.
func quietLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

func TestRetention(t *testing.T) {
	t.Parallel()

	t.Run("prune_child_logs_by_age", func(t *testing.T) {
		dir := t.TempDir()
		fresh := filepath.Join(dir, "100.log")
		stale := filepath.Join(dir, "200.log")
		staleArchive := filepath.Join(dir, "300.log.1")
		freshArchive := filepath.Join(dir, "400.log.2")
		nested := filepath.Join(dir, "nested.log")
		require.NoError(t, os.WriteFile(fresh, []byte("keep"), 0o600))
		require.NoError(t, os.WriteFile(stale, []byte("drop"), 0o600))
		require.NoError(t, os.WriteFile(staleArchive, []byte("drop"), 0o600))
		require.NoError(t, os.WriteFile(freshArchive, []byte("keep"), 0o600))
		require.NoError(t, os.WriteFile(nested, []byte("drop"), 0o600))
		old := time.Now().Add(-time.Hour)
		for _, path := range []string{stale, staleArchive, nested} {
			require.NoError(t, os.Chtimes(path, old, old))
		}
		require.NoError(t, os.Mkdir(filepath.Join(dir, "500.dir.log"), 0o700))

		pruneChildLogs(dir, time.Now().Add(-30*time.Minute), quietLogger())

		assert.FileExists(t, fresh)
		assert.NoFileExists(t, stale)
		assert.NoFileExists(t, staleArchive) // rotated archives age out with the logs
		assert.FileExists(t, freshArchive)
		assert.NoFileExists(t, nested)
		assert.DirExists(t, filepath.Join(dir, "500.dir.log"))
	})

	t.Run("rotate_child_logs_over_cap", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "4242.log")
		require.NoError(t, os.WriteFile(path, []byte(strings.Repeat("x", 64)), 0o600))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(strings.Repeat("x", 64)), 0o600))

		RotateChildLogs(dir, 32, 1, quietLogger())

		live, err := os.ReadFile(path)
		require.NoError(t, err)
		assert.Empty(t, live)
		one, err := os.ReadFile(path + ".1")
		require.NoError(t, err)
		assert.Len(t, one, 64)
		txt, err := os.ReadFile(filepath.Join(dir, "notes.txt"))
		require.NoError(t, err)
		assert.Len(t, txt, 64)
	})

	t.Run("zero_cap_and_missing_dir", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "4242.log")
		require.NoError(t, os.WriteFile(path, []byte(strings.Repeat("x", 64)), 0o600))

		RotateChildLogs(dir, 0, 1, quietLogger())
		got, err := os.ReadFile(path)
		require.NoError(t, err)
		assert.Len(t, got, 64)

		RotateChildLogs(filepath.Join(dir, "absent"), 32, 1, quietLogger())
		assert.NoFileExists(t, filepath.Join(dir, "absent"))
	})
}
