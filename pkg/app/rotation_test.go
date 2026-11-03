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

// The daemon child's inherited stderr rides the log file its parent opened,
// so startLogRotation copytruncates it on a cadence.
func TestStartLogRotationTruncatesDaemonLog(t *testing.T) {
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
	}, 2*time.Second, 10*time.Millisecond, "the oversized daemon log copytruncates")

	one, err := os.ReadFile(logPath + ".1")
	require.NoError(t, err)
	assert.Len(t, one, 96)
}

// A disabled cap installs a no-op stopper and leaves files alone.
func TestStartLogRotationDisabled(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, logFileName)
	require.NoError(t, os.WriteFile(logPath, []byte(strings.Repeat("x", 96)), 0o600))

	stop := startLogRotation(dir, Options{LogMaxBytes: 0}, quietLogger())
	stop()

	got, err := os.ReadFile(logPath)
	require.NoError(t, err)
	assert.Len(t, got, 96)
	assert.NoFileExists(t, logPath+".1")
}

// A foreground service owns its --log through the rotating Writer but not its
// children's captured logs: those still copytruncate on the cadence.
func TestStartLogRotationForegroundChildLogs(t *testing.T) {
	t.Parallel()

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
	}, 2*time.Second, 10*time.Millisecond, "the oversized child log copytruncates")
}
