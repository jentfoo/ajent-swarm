package fleet

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// settingsMemStore is an in-memory SettingsStore for manager-level tests.
type settingsMemStore struct {
	mu       sync.Mutex
	settings map[string]string
}

func newSettingsMemStore() *settingsMemStore {
	return &settingsMemStore{settings: make(map[string]string)}
}

func (s *settingsMemStore) SetSetting(_ context.Context, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if value == "" {
		delete(s.settings, key)
		return nil
	}
	s.settings[key] = value
	return nil
}

func (s *settingsMemStore) Setting(_ context.Context, key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings[key], nil
}

func (s *settingsMemStore) snapshot() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.settings))
	for k, v := range s.settings {
		out[k] = v
	}
	return out
}
func TestSettings(t *testing.T) {
	t.Run("title_model_roundtrip", func(t *testing.T) {
		store := newSettingsMemStore()
		bin, _ := fakeNamerBin(t)
		m, _ := newTestFleetWithSettings(t, store, bin)

		assert.Empty(t, m.TitleModel()) // the store starts empty

		require.NoError(t, m.SetTitleModel(t.Context(), " namer-model "))
		assert.Equal(t, "namer-model", m.TitleModel())
		assert.Equal(t, map[string]string{SettingKeyTitleModel: "namer-model"}, store.snapshot())

		require.NoError(t, m.SetTitleModel(t.Context(), ""))
		assert.Empty(t, m.TitleModel())
		assert.Empty(t, store.snapshot()) // clearing removes the row
	})

	t.Run("title_model_needs_store", func(t *testing.T) {
		testutil.IsolateHome(t)
		m := New(Options{Log: testLogger(), PollInterval: testPoll,
			BackoffBase: testBackoff, BackoffMax: testBackoffHi})
		ctx, cancel := context.WithCancel(t.Context())
		m.Start(ctx)
		t.Cleanup(func() {
			cancel()
			m.Stop()
		})

		assert.ErrorIs(t, m.SetTitleModel(t.Context(), "m"), ErrNoSettingStore)
	})

	t.Run("namer_runs_configured_model", func(t *testing.T) {
		logPath := filepath.Join(t.TempDir(), "namer-args.log")
		store := newSettingsMemStore()
		m, home := newTestFleetWithSettings(t, store, argsNamerBin(t, logPath, false))
		require.NoError(t, m.SetTitleModel(t.Context(), "namer-model"))

		nameOneSession(t, m, home, "01NAMERMODEL000000001")

		run, err := os.ReadFile(logPath)
		require.NoError(t, err)
		assert.Contains(t, string(run), "--model namer-model")
		assert.Equal(t, map[string]string{SettingKeyTitleModel: "namer-model"}, store.snapshot())
	})

	t.Run("namer_falls_back_to_default", func(t *testing.T) {
		logPath := filepath.Join(t.TempDir(), "namer-args.log")
		store := newSettingsMemStore()
		m, home := newTestFleetWithSettings(t, store, argsNamerBin(t, logPath, true))
		require.NoError(t, m.SetTitleModel(t.Context(), "missing-model"))

		// the configured run fails, the setting drops to the default and the same
		// naming attempt still lands a label through the plain run
		nameOneSession(t, m, home, "01NAMERFALLBK00000001")

		assert.Empty(t, store.snapshot())
		assert.Empty(t, m.TitleModel())
		run, err := os.ReadFile(logPath)
		require.NoError(t, err)
		assert.NotContains(t, string(run), "--model")
	})
}

func argsNamerBin(t *testing.T, logPath string, failWithModel bool) string {
	t.Helper()
	script := "#!/bin/sh\n"
	if failWithModel {
		script += `for arg in "$@"; do [ "$arg" = "--model" ] && exit 9; done` + "\n"
	}
	script += `printf '%s\n' "$*" >> ` + logPath + "\necho 'Fix login flow'\n"
	path := filepath.Join(t.TempDir(), "ajent-fake")
	require.NoError(t, os.WriteFile(path, []byte(script), 0o700))
	return path
}

func newTestFleetWithSettings(t *testing.T, store SettingsStore, bin string) (*Manager, string) {
	t.Helper()
	home := testutil.IsolateHome(t)
	m := New(Options{
		Log:          testLogger(),
		PollInterval: testPoll,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		AjentBin:     bin,
		TitleStore:   newTitleMemStore(),
		SettingStore: store,
	})
	ctx, cancel := context.WithCancel(t.Context())
	m.Start(ctx)
	t.Cleanup(func() {
		cancel()
		m.Stop()
	})
	return m, home
}

func nameOneSession(t *testing.T, m *Manager, home, sessionID string) {
	t.Helper()
	f := fleettest.New(t, home, fleettest.Options{SessionID: sessionID})
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)
	f.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: wireEntry(session.Entry{
		ID:   "01SETTINGPROMPT000001",
		Type: session.TypeMessage,
		Data: mustJSON(session.MessageData{
			Message: llm.Text(llm.RoleUser, "fix the login flow"),
		}),
	})})
	require.Eventually(t, func() bool {
		rows := m.Sessions()
		return len(rows) == 1 && rows[0].Title == "Fix login flow"
	}, 2*time.Second, testPoll)
}
