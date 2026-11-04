package fleet

import (
	"context"
	"maps"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"
)

// titleMemStore is an in-memory TitleStore for manager-level tests. The
// manager touches it from handler goroutines and the async namer, so every
// access locks.
type titleMemStore struct {
	mu     sync.Mutex
	titles map[string]string
}

func newTitleMemStore() *titleMemStore {
	return &titleMemStore{titles: make(map[string]string)}
}

func (s *titleMemStore) SetSessionTitle(_ context.Context, sessionID, title string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if title == "" {
		delete(s.titles, sessionID)
		return nil
	}
	s.titles[sessionID] = title
	return nil
}

func (s *titleMemStore) SessionTitles(context.Context) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.titles))
	for id, t := range s.titles {
		out[id] = t
	}
	return out, nil
}

// snapshot copies the store for direct assertions in tests.
func (s *titleMemStore) snapshot() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return maps.Clone(s.titles)
}
func TestTitles(t *testing.T) {
	t.Run("manager titles", func(t *testing.T) {
		store := newTitleMemStore()
		m, home := newTestFleetWithTitles(t, store)

		f := fleettest.New(t, home, fleettest.Options{SessionID: "01TITLED0000000000"})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		// a rename writes through and shows up on the listing
		require.NoError(t, m.SetTitle(t.Context(), f.SessionID(), "fix login flow"))
		rows := m.Sessions()
		require.Len(t, rows, 1)
		assert.Equal(t, "fix login flow", rows[0].Title)
		assert.Empty(t, rows[0].Name)

		// clearing falls back to name-less labels
		require.NoError(t, m.SetTitle(t.Context(), f.SessionID(), ""))
		rows = m.Sessions()
		require.Len(t, rows, 1)
		assert.Empty(t, rows[0].Title)
	})

	t.Run("titles survive restart", func(t *testing.T) {
		store := newTitleMemStore()
		m := New(Options{Log: testLogger(), TitleStore: store})
		ctx, cancel := context.WithCancel(t.Context())
		m.Start(ctx)
		require.NoError(t, m.SetTitle(ctx, "01TITLED0000000000", "couch session"))
		m.Stop()
		cancel()

		// a fresh manager over the same store loads its titles at Start
		m2 := New(Options{Log: testLogger(), TitleStore: store})
		ctx2 := t.Context()
		m2.Start(ctx2)
		t.Cleanup(m2.Stop)
		assert.Equal(t, "couch session", m2.titleFor("01TITLED0000000000"))
	})

	t.Run("titles require store", func(t *testing.T) {
		m := New(Options{Log: testLogger()})
		err := m.SetTitle(t.Context(), "01A", "x")
		require.ErrorIs(t, err, ErrNoTitleStore)
	})

	t.Run("set title validation", func(t *testing.T) {
		store := newTitleMemStore()
		m := New(Options{Log: testLogger(), TitleStore: store})
		ctx := t.Context()

		err := m.SetTitle(ctx, "  ", "x")
		require.ErrorIs(t, err, ErrUnknownSession)

		// oversized titles clip instead of poisoning rows
		require.NoError(t, m.SetTitle(ctx, "01A", string(make([]rune, maxTitleRunes+10))))
		assert.Len(t, store.snapshot()["01A"], maxTitleRunes)
	})
}

func newTestFleetWithTitles(t *testing.T, store TitleStore) (*Manager, string) {
	t.Helper()
	home := testutil.IsolateHome(t)
	m := New(Options{
		Log:          testLogger(),
		PollInterval: testPoll,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		TitleStore:   store,
	})
	ctx, cancel := context.WithCancel(t.Context())
	m.Start(ctx)
	t.Cleanup(func() {
		cancel()
		m.Stop()
	})
	return m, home
}
