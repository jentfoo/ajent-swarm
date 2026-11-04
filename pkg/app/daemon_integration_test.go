//go:build unix

package app

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// moduleRootPackage is the main package of this module, built by the test
// itself so daemon mode runs against a real binary.
const moduleRootPackage = "github.com/jentfoo/ajent-swarm"

func TestDaemonLifecycle(t *testing.T) {
	switch runtime.GOOS {
	case "linux", "darwin":
	default:
		t.Skipf("daemon lifecycle test unsupported on %s", runtime.GOOS)
	}
	if os.Getenv("AJENT_SWARM_INTEGRATION") == "" {
		t.Skip("set AJENT_SWARM_INTEGRATION=1 to run the daemon integration test")
	}

	bin := filepath.Join(t.TempDir(), "ajent-swarm")
	ctx := t.Context()
	build := exec.CommandContext(ctx, "go", "build", "-o", bin, moduleRootPackage)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}

	home := t.TempDir()
	port := freeTCPPort(t)

	cmd := exec.CommandContext(ctx, bin, "--daemon", "--port", port, "--host", "127.0.0.1")
	cmd.Env = append(os.Environ(), "AJENT_HOME="+home)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("daemonize failed: %v\n%s", err, out)
	} else {
		assert.Contains(t, string(out), "daemon started")
	}

	base := "http://127.0.0.1:" + port
	pidPath := filepath.Join(home, swarmDirName, pidFileName)

	// the login-gated placeholder answers with the bootstrap-required marker
	require.Eventually(t, func() bool {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/me", nil)
		if err != nil {
			return false
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return false
		}
		defer func() { _ = resp.Body.Close() }()
		return resp.StatusCode == http.StatusServiceUnavailable
	}, 10*time.Second, 50*time.Millisecond)

	t.Run("pidfile and log under the ajent home", func(t *testing.T) {
		data, err := os.ReadFile(pidPath)
		require.NoError(t, err)
		pid := mustAtoi(t, string(data))
		assert.Positive(t, pid)

		info, err := os.Stat(filepath.Join(home, swarmDirName, logFileName))
		require.NoError(t, err)
		assert.Positive(t, info.Size())
	})

	t.Run("sigterm shuts down cleanly", func(t *testing.T) {
		data, err := os.ReadFile(pidPath)
		require.NoError(t, err)
		pid := mustAtoi(t, string(data))
		require.NoError(t, syscall.Kill(pid, syscall.SIGTERM))

		// no pidfile left behind and the port stops answering
		require.Eventually(t, func() bool {
			if _, err := os.Stat(pidPath); !os.IsNotExist(err) {
				return false
			}
			dialer := &net.Dialer{}
			conn, err := dialer.DialContext(ctx, "tcp", "127.0.0.1:"+port)
			if err != nil {
				return true // connection refused: the listener is gone
			}
			_ = conn.Close()
			return false
		}, 15*time.Second, 50*time.Millisecond)

		assert.False(t, processAlive(pid))
	})
}

// freeTCPPort reserves an ephemeral port and hands it back for later binding.
// The racy window is small enough for an integration test.
func freeTCPPort(t *testing.T) string {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(context.Background(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = ln.Close() }()
	return strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
}

// processAlive reports whether a pid still answers signal zero.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}
