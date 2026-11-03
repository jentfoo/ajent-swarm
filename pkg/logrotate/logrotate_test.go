package logrotate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWriterRotatesAtCap(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "swarm.log")
	w, err := NewWriter(path, 40, 2)
	require.NoError(t, err)
	t.Cleanup(func() { _ = w.Close() })

	line := strings.Repeat("a", 16)
	for i := 0; i < 10; i++ {
		_, err = w.Write([]byte(line + "\n"))
		require.NoError(t, err)
	}

	// the live file keeps whole lines only and the archives hold the rest,
	// oldest content furthest from the live name
	live, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.LessOrEqual(t, len(live), 34, "at most two lines past the cap")
	assert.NotEmpty(t, live)

	one, err := os.ReadFile(path + ".1")
	require.NoError(t, err)
	assert.NotEmpty(t, one)
	assert.Empty(t, strings.Trim(string(one), "a\n"), "archive lines are whole")

	// the cap bounds the archive count
	assert.NoFileExists(t, path+".3")
}

func TestWriterZeroCapDisablesRotation(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "swarm.log")
	w, err := NewWriter(path, 0, 2)
	require.NoError(t, err)
	t.Cleanup(func() { _ = w.Close() })

	_, err = w.Write([]byte(strings.Repeat("x", 200)))
	require.NoError(t, err)
	assert.NoFileExists(t, path+".1")
}

func TestWriterWriteAfterClose(t *testing.T) {
	t.Parallel()

	w, err := NewWriter(filepath.Join(t.TempDir(), "swarm.log"), 10, 1)
	require.NoError(t, err)
	require.NoError(t, w.Close())

	_, err = w.Write([]byte("late"))
	require.ErrorIs(t, err, ErrClosed)
	assert.NoError(t, w.Close())
}

func TestTruncateRotateOverCap(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "child.log")
	old := strings.Repeat("o", 50)
	require.NoError(t, os.WriteFile(path, []byte(old), 0o600))

	require.NoError(t, TruncateRotate(path, 32, 2))

	live, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Empty(t, live, "the live file truncates to zero")
	got, err := os.ReadFile(path + ".1")
	require.NoError(t, err)
	assert.Equal(t, old, string(got))
}

func TestTruncateRotateUnderCapAndMissing(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "child.log")
	require.NoError(t, os.WriteFile(path, []byte("small"), 0o600))

	require.NoError(t, TruncateRotate(path, 100, 1))
	got, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, "small", string(got))
	assert.NoFileExists(t, path+".1")

	assert.NoError(t, TruncateRotate(filepath.Join(dir, "absent.log"), 1, 1))
}

func TestTruncateRotateShiftsArchives(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "child.log")
	require.NoError(t, os.WriteFile(path, []byte(strings.Repeat("n", 40)), 0o600))
	require.NoError(t, os.WriteFile(path+".1", []byte("first"), 0o600))
	require.NoError(t, os.WriteFile(path+".2", []byte("second"), 0o600))

	require.NoError(t, TruncateRotate(path, 16, 2))

	// second rotates off the end, first moves up, live content becomes .1
	got, err := os.ReadFile(path + ".1")
	require.NoError(t, err)
	assert.Equal(t, strings.Repeat("n", 40), string(got))
	got, err = os.ReadFile(path + ".2")
	require.NoError(t, err)
	assert.Equal(t, "first", string(got))
	assert.NoFileExists(t, path+".3")
	live, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Empty(t, live)
}

func TestTruncateRotateZeroCap(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "child.log")
	require.NoError(t, os.WriteFile(path, []byte(strings.Repeat("n", 40)), 0o600))

	require.NoError(t, TruncateRotate(path, 0, 1))
	got, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Len(t, got, 40)
}

func TestTruncateRotateZeroBackups(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "child.log")
	require.NoError(t, os.WriteFile(path, []byte(strings.Repeat("n", 40)), 0o600))
	require.NoError(t, os.WriteFile(path+".1", []byte("stale"), 0o600))

	require.NoError(t, TruncateRotate(path, 16, 0))
	got, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Empty(t, got, "the live log truncates with no archive kept")
	stale, err := os.ReadFile(path + ".1")
	require.NoError(t, err)
	assert.Equal(t, "stale", string(stale), "zero backups never writes archives")
}
