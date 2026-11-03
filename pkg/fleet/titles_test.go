package fleet

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
)

// titleMemStore is an in-memory TitleStore for manager-level tests.
type titleMemStore struct {
	titles map[string]string
}

func newTitleMemStore() *titleMemStore {
	return &titleMemStore{titles: make(map[string]string)}
}

func (s *titleMemStore) SetSessionTitle(_ context.Context, sessionID, title string) error {
	if title == "" {
		delete(s.titles, sessionID)
		return nil
	}
	s.titles[sessionID] = title
	return nil
}

func (s *titleMemStore) SessionTitles(context.Context) (map[string]string, error) {
	out := make(map[string]string, len(s.titles))
	for id, t := range s.titles {
		out[id] = t
	}
	return out, nil
}

func TestManagerTitles(t *testing.T) {
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
}

func TestManagerTitlesSurviveRestart(t *testing.T) {
	store := newTitleMemStore()
	m := New(Options{Log: testLogger(), TitleStore: store})
	ctx, cancel := context.WithCancel(context.Background())
	m.Start(ctx)
	require.NoError(t, m.SetTitle(ctx, "01TITLED0000000000", "couch session"))
	m.Stop()
	cancel()

	// a fresh manager over the same store loads its titles at Start
	m2 := New(Options{Log: testLogger(), TitleStore: store})
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	m2.Start(ctx2)
	t.Cleanup(m2.Stop)
	assert.Equal(t, "couch session", m2.titleFor("01TITLED0000000000"))
}

func TestManagerTitlesRequireStore(t *testing.T) {
	m := New(Options{Log: testLogger()})
	err := m.SetTitle(context.Background(), "01A", "x")
	require.ErrorIs(t, err, ErrNoTitleStore)
}

func TestManagerSetTitleValidation(t *testing.T) {
	store := newTitleMemStore()
	m := New(Options{Log: testLogger(), TitleStore: store})
	ctx := context.Background()

	err := m.SetTitle(ctx, "  ", "x")
	require.ErrorIs(t, err, ErrUnknownSession)

	// oversized titles clip instead of poisoning rows
	require.NoError(t, m.SetTitle(ctx, "01A", string(make([]rune, maxTitleRunes+10))))
	assert.Len(t, store.titles["01A"], maxTitleRunes)
}

// newTestFleetWithTitles starts a fast manager whose titles persist to store.
func newTestFleetWithTitles(t *testing.T, store TitleStore) (*Manager, string) {
	t.Helper()
	home, err := os.MkdirTemp("", "fleet")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("AJENT_HOME", home)
	m := New(Options{
		Log:          testLogger(),
		PollInterval: testPoll,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		TitleStore:   store,
	})
	ctx, cancel := context.WithCancel(context.Background())
	m.Start(ctx)
	t.Cleanup(func() {
		cancel()
		m.Stop()
	})
	return m, home
}
