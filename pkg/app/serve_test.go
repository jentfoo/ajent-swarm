//go:build unix

package app

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

// quietLogger drops everything, keeping rotation warnings out of test output.
func quietLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

func TestStartLogRotation(t *testing.T) {
	// not parallel: t.Setenv mutates process state

	t.Run("daemon_log_copytruncates", func(t *testing.T) {
		// the daemon child's inherited stderr rides the log file its parent
		// opened, so startLogRotation copytruncates it on a cadence
		t.Setenv(daemonChildEnv, "1")

		dir := t.TempDir()
		logPath := filepath.Join(dir, logFileName)
		big := strings.Repeat("x", 96)
		require.NoError(t, os.WriteFile(logPath, []byte(big), 0o600))

		prev := rotateEvery
		rotateEvery = 10 * time.Millisecond
		t.Cleanup(func() { rotateEvery = prev })

		opts := Options{LogMaxBytes: 32, LogBackups: 1}
		stop := startLogRotation(dir, opts, quietLogger())
		t.Cleanup(stop)

		require.Eventually(t, func() bool {
			info, err := os.Stat(logPath)
			return err == nil && info.Size() == 0
		}, 2*time.Second, 10*time.Millisecond)

		one, err := os.ReadFile(logPath + ".1")
		require.NoError(t, err)
		assert.Len(t, one, 96)
	})

	t.Run("disabled_cap_leaves_files_alone", func(t *testing.T) {
		dir := t.TempDir()
		logPath := filepath.Join(dir, logFileName)
		require.NoError(t, os.WriteFile(logPath, []byte(strings.Repeat("x", 96)), 0o600))

		stop := startLogRotation(dir, Options{LogMaxBytes: 0}, quietLogger())
		stop()

		got, err := os.ReadFile(logPath)
		require.NoError(t, err)
		assert.Len(t, got, 96)
		assert.NoFileExists(t, logPath+".1")
	})

	t.Run("foreground_child_logs_copytruncate", func(t *testing.T) {
		dir := t.TempDir()
		childrenDir := filepath.Join(dir, childrenDirName)
		require.NoError(t, os.Mkdir(childrenDir, 0o700))
		childPath := filepath.Join(childrenDir, "4242.log")
		require.NoError(t, os.WriteFile(childPath, []byte(strings.Repeat("x", 96)), 0o600))

		prev := rotateEvery
		rotateEvery = 10 * time.Millisecond
		t.Cleanup(func() { rotateEvery = prev })

		stop := startLogRotation(dir, Options{LogMaxBytes: 32, LogBackups: 1}, quietLogger())
		t.Cleanup(stop)

		require.Eventually(t, func() bool {
			info, err := os.Stat(childPath)
			return err == nil && info.Size() == 0
		}, 2*time.Second, 10*time.Millisecond)
	})
}
