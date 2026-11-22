//go:build unix

package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// moduleRootPackage is the main package of this module, built by the test
// itself so daemon mode runs against a real binary.
const moduleRootPackage = "github.com/jentfoo/ajent-swarm"

func TestDaemon(t *testing.T) {
	t.Run("password_handoff", func(t *testing.T) {
		switch runtime.GOOS {
		case "linux", "darwin":
		default:
			t.Skipf("daemon password handoff unsupported on %s", runtime.GOOS)
		}
		if os.Getenv("AJENT_SWARM_INTEGRATION") == "" {
			t.Skip("set AJENT_SWARM_INTEGRATION=1 to run the daemon integration test")
		}

		ctx := t.Context()
		bin := buildSwarm(t)
		// --ajent-bin points at a stub so startup never resolves PATH
		stubAjent := filepath.Join(t.TempDir(), "ajent")
		require.NoError(t, os.WriteFile(stubAjent,
			[]byte("#!/bin/sh\necho 'ajent version v0.0.0-stub'\n"), 0o755))
		port := freeTCPPort(t)
		home := t.TempDir()
		const loginPW = "handoff-secret"

		t.Run("parent_hands_off_environment_value", func(t *testing.T) {
			cmd := exec.CommandContext(ctx, bin, "--daemon", "--password", "--port", port,
				"--host", "127.0.0.1", "--ajent-bin", stubAjent)
			// the parent's stdin is not a terminal, so resolution reads PasswordEnv
			cmd.Env = append(os.Environ(),
				PasswordEnv+"="+loginPW,
				"AJENT_HOME="+home)
			_, err := cmd.CombinedOutput()
			require.NoError(t, err)

			pidData, err := os.ReadFile(filepath.Join(home, swarmDirName, pidFileName))
			require.NoError(t, err)
			pid := mustAtoi(t, string(pidData))
			t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGTERM) })

			// the child applied the handed-off value: it now logs in over HTTP.
			// The unset itself cannot be observed here: /proc/<pid>/environ is an
			// exec-time snapshot, so consumption stays a unit-level guarantee
			// (resolveLoginPassword unsets before either flow answers).
			u, err := user.Current()
			require.NoError(t, err)
			body, err := json.Marshal(map[string]string{"username": u.Username, "password": loginPW})
			require.NoError(t, err)
			base := "http://127.0.0.1:" + port
			require.Eventually(t, func() bool {
				req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost,
					base+"/api/auth/login", bytes.NewReader(body))
				if reqErr != nil {
					return false
				}
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					return false
				}
				_ = resp.Body.Close()
				return resp.StatusCode == http.StatusNoContent
			}, 10*time.Second, 50*time.Millisecond)

			if runtime.GOOS == "linux" {
				envData, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
				require.NoError(t, err)
				assert.Contains(t, string(envData), PasswordEnv+"="+loginPW)
			}
		})

		t.Run("missing_environment_fails_usage", func(t *testing.T) {
			// no --port: startup fails at password resolution long before binding
			cmd := exec.CommandContext(ctx, bin, "--password")
			cmd.Env = append(envWithout(os.Environ(), PasswordEnv), "AJENT_HOME="+t.TempDir())
			out, err := cmd.CombinedOutput()

			require.Error(t, err)
			assert.Contains(t, string(out), PasswordEnv)
		})
	})

	t.Run("lifecycle", func(t *testing.T) {
		switch runtime.GOOS {
		case "linux", "darwin":
		default:
			t.Skipf("daemon lifecycle test unsupported on %s", runtime.GOOS)
		}
		if os.Getenv("AJENT_SWARM_INTEGRATION") == "" {
			t.Skip("set AJENT_SWARM_INTEGRATION=1 to run the daemon integration test")
		}

		bin := buildSwarm(t)
		ctx := t.Context()

		home := t.TempDir()
		port := freeTCPPort(t)
		// registered once the daemon is up, so a failed subtest never leaks it
		parent := t

		base := "http://127.0.0.1:" + port
		pidPath := filepath.Join(home, swarmDirName, pidFileName)

		t.Run("daemon_starts_and_answers", func(t *testing.T) {
			// --ajent-bin points at a stub so startup never resolves PATH
			stubAjent := filepath.Join(t.TempDir(), "ajent")
			require.NoError(t, os.WriteFile(stubAjent,
				[]byte("#!/bin/sh\necho 'ajent version v0.0.0-stub'\n"), 0o755))

			cmd := exec.CommandContext(ctx, bin, "--daemon", "--port", port, "--host", "127.0.0.1",
				"--ajent-bin", stubAjent)
			cmd.Env = append(os.Environ(), "AJENT_HOME="+home)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("daemonize failed: %v\n%s", err, out)
			} else {
				assert.Contains(t, string(out), "daemon started")
			}

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
				_ = resp.Body.Close()
				return resp.StatusCode == http.StatusServiceUnavailable
			}, 10*time.Second, 50*time.Millisecond)

			// the daemon outlives this subtest: cleanup rides the lifecycle level
			if data, err := os.ReadFile(pidPath); err == nil {
				pid := mustAtoi(t, string(data))
				parent.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGTERM) })
			}
		})

		t.Run("chain_survives_restart", func(t *testing.T) {
			switch runtime.GOOS {
			case "linux", "darwin":
			default:
				t.Skipf("daemon chain restart unsupported on %s", runtime.GOOS)
			}
			if os.Getenv("AJENT_SWARM_INTEGRATION") == "" {
				t.Skip("set AJENT_SWARM_INTEGRATION=1 to run the daemon integration test")
			}

			bin := buildSwarm(t)
			ctx := t.Context()
			home := t.TempDir()
			port := freeTCPPort(t)
			base := "http://127.0.0.1:" + port
			pidPath := filepath.Join(home, swarmDirName, pidFileName)
			stubAjent := filepath.Join(t.TempDir(), "ajent")
			require.NoError(t, os.WriteFile(stubAjent,
				[]byte("#!/bin/sh\necho 'ajent version v0.0.0-stub'\n"), 0o755))

			// two serving stubs the daemon discovers and dials, the parent holds
			// a running turn so the chain waits past the restart
			parent := fleettest.New(t, home, fleettest.Options{
				SessionID: "01PARENTSESSION00000A", Transcript: "parent.jsonl"})
			parent.WriteTranscript(t, daemonEntry("01A1", "", llm.RoleAssistant, "recorded answer"))
			parent.SetSnapshot(ctl.State{
				Session: ctl.Session{ID: parent.SessionID()}, Head: "01A1", Running: true})
			parent.WriteRegistry(t, os.Getpid(), time.Now())
			child := fleettest.New(t, home, fleettest.Options{
				SessionID: "01CHILDSESSION00000B", Transcript: "child.jsonl"})
			child.SetSnapshot(ctl.State{Session: ctl.Session{ID: child.SessionID()}})
			child.WriteRegistry(t, os.Getpid(), time.Now())

			startDaemon := func(t *testing.T) {
				t.Helper()
				cmd := exec.CommandContext(ctx, bin, "--daemon", "--port", port,
					"--host", "127.0.0.1", "--ajent-bin", stubAjent)
				cmd.Env = append(os.Environ(), "AJENT_HOME="+home)
				out, err := cmd.CombinedOutput()
				require.NoError(t, err, string(out))
				require.Eventually(t, func() bool {
					req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/me", nil)
					if reqErr != nil {
						return false
					}
					resp, err := http.DefaultClient.Do(req)
					if err != nil {
						return false
					}
					_ = resp.Body.Close()
					// any answer proves the listener is up: 503 before bootstrap,
					// 401 anonymous once bootstrapped, 200 authed
					return resp.StatusCode == http.StatusOK ||
						resp.StatusCode == http.StatusUnauthorized ||
						resp.StatusCode == http.StatusServiceUnavailable
				}, 10*time.Second, 50*time.Millisecond)
			}
			stopDaemon := func(t *testing.T) {
				t.Helper()
				data, err := os.ReadFile(pidPath)
				require.NoError(t, err)
				pid := mustAtoi(t, string(data))
				require.NoError(t, syscall.Kill(pid, syscall.SIGTERM))
				require.Eventually(t, func() bool { return !processAlive(pid) },
					15*time.Second, 50*time.Millisecond)
			}

			jar, err := cookiejar.New(nil)
			require.NoError(t, err)
			client := &http.Client{Jar: jar}
			u, err := user.Current()
			require.NoError(t, err)
			login := func(t *testing.T) {
				t.Helper()
				code, _ := daemonJSON(t, client, base, http.MethodPost, "/api/auth/login",
					map[string]string{"username": u.Username, "password": "chain-secret"})
				require.Equal(t, http.StatusNoContent, code)
			}

			startDaemon(t)
			t.Cleanup(func() {
				if data, err := os.ReadFile(pidPath); err == nil {
					_ = syscall.Kill(mustAtoi(t, string(data)), syscall.SIGTERM)
				}
			})
			// bootstrap answers once, the password then outlives restarts
			code, _ := daemonJSON(t, client, base, http.MethodPost, "/api/auth/bootstrap",
				map[string]string{"password": "chain-secret"})
			require.Equal(t, http.StatusNoContent, code)
			login(t)

			// both sessions serve and the parent holds its turn before chaining
			require.Eventually(t, func() bool {
				code, body := daemonJSON(t, client, base, http.MethodGet, "/api/attention", nil)
				if code != http.StatusOK {
					return false
				}
				var parentRunning, childSeen bool
				for _, raw := range body.([]any) {
					row := raw.(map[string]any)
					switch row["sessionId"] {
					case parent.SessionID():
						parentRunning = row["running"] == true
					case child.SessionID():
						childSeen = true
					}
				}
				return parentRunning && childSeen
			}, 10*time.Second, 100*time.Millisecond)

			code, body := daemonJSON(t, client, base, http.MethodPost,
				"/api/sessions/"+parent.SessionID()+"/chain",
				map[string]string{"childId": child.SessionID(), "childPrompt": "continue"})
			require.Equal(t, http.StatusCreated, code)
			require.Equal(t, "waiting", body.(map[string]any)["state"])

			stopDaemon(t)
			// the turn ended while the service was down: the snapshot no longer
			// holds a running turn, the restored chain delivers once the parent
			// is free; no final prompt means the bare child prompt, no response
			parent.SetSnapshot(ctl.State{
				Session: ctl.Session{ID: parent.SessionID()}, Head: "01A1", Idle: true})
			startDaemon(t)
			login(t)

			require.Eventually(t, func() bool {
				for _, req := range child.Received() {
					if req.Method != ctl.MethodSubmit {
						continue
					}
					var p ctl.SubmitParams
					if json.Unmarshal(req.Params, &p) == nil && p.Line == "continue" {
						return true
					}
				}
				return false
			}, 30*time.Second, 100*time.Millisecond)
		})

		t.Run("sigterm_shuts_down_cleanly", func(t *testing.T) {
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
	})
}

// buildSwarm builds the real binary so daemon mode runs against a fresh one.
func buildSwarm(t *testing.T) string {
	t.Helper()

	bin := filepath.Join(t.TempDir(), "ajent-swarm")
	build := exec.CommandContext(t.Context(), "go", "build", "-o", bin, moduleRootPackage)
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// envWithout returns environ minus the named variable.
func envWithout(environ []string, key string) []string {
	return bulk.SliceFilter(func(kv string) bool {
		return !strings.HasPrefix(kv, key+"=")
	}, environ)
}

// freeTCPPort reserves an ephemeral port and hands it back for later binding.
// The racy window is small enough for an integration test.
func freeTCPPort(t *testing.T) string {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close() // released before return, so the daemon can bind it
	return strconv.Itoa(port)
}

// processAlive reports whether a pid still answers signal zero.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

// daemonJSON issues one JSON request against a running daemon and decodes
// the reply body, nil for bodies that carry none.
func daemonJSON(t *testing.T, client *http.Client, base, method, path string,
	body any,
) (int, any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(t.Context(), method, base+path, reader)
	require.NoError(t, err)
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNoContent {
		return resp.StatusCode, nil
	}
	var out any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return resp.StatusCode, out
}

// daemonEntry builds one transcript entry for a stub the daemon backfills.
func daemonEntry(id, parent string, role llm.Role, text string) session.Entry {
	raw, err := json.Marshal(session.MessageData{Message: llm.Text(role, text)})
	if err != nil {
		panic(err)
	}
	return session.Entry{ID: id, ParentID: parent, Type: session.TypeMessage, TS: 100, Data: raw}
}
