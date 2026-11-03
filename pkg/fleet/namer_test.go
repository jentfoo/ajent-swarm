package fleet

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// The namer runs a one-shot ajent exec and stores the answer as swarm's own
// display title: no upstream submit may ever touch ajent session names.

func TestSanitizeSessionTitle(t *testing.T) {
	t.Parallel()

	cases := []struct{ in, want string }{
		{"Fix the login flow", "Fix the login flow"},
		{"  padded   spaces  collapse ", "padded spaces collapse"},
		{"first line only\nsecond line dropped", "first line only"},
		{"\n", ""},
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, sanitizeSessionTitle(tc.in))
	}

	assert.Empty(t, sanitizeSessionTitle(""))
}

// fakeNamerBin writes an executable that prints a fixed label, standing in
// for ajent's one-shot -p run.
func fakeNamerBin(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ajent-fake")
	require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\necho 'Fix login flow'\n"), 0o700))
	return path
}

func TestNamerTitlesFromFirstPrompt(t *testing.T) {
	store := newTitleMemStore()
	owned := func(inst ctl.Instance) bool { return inst.SessionID == "01AUTOTITLE0000000" }
	m, home := newTestFleetWithTitlesAndBin(t, store, fakeNamerBin(t), owned)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01AUTOTITLE0000000"})
	first := session.Entry{
		ID:   "01PROMPTENTRY00000000",
		Type: session.TypeMessage,
		Data: mustJSON(session.MessageData{
			Message: llm.Text(llm.RoleUser, "fix the login flow"),
		}),
	}
	f.WriteTranscript(t, first)
	f.WriteRegistry(t, os.Getpid(), time.Now())

	waitForState(t, m, f.SessionID(), ChildOnline)

	// the labeler schedules on a live first-typed-prompt commit; backfill alone
	// never names a session that existed before this run attached. The actor's
	// own control connection receives the broadcast.
	next := first
	next.ID = "01PROMPTENTRY00000001"
	next.ParentID = first.ID
	f.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: wireEntry(next)})

	// the labeler runs once over the first typed prompt and writes through
	require.Eventually(t, func() bool {
		return store.snapshot()[f.SessionID()] == "Fix login flow"
	}, 2*time.Second, testPoll)

	// every surface sees the title; ajent's own session name stays clean
	rows := m.Sessions()
	require.Len(t, rows, 1)
	assert.Equal(t, "Fix login flow", rows[0].Title)
	assert.Empty(t, rows[0].Name)

	for _, req := range f.Received() {
		if req.Method == ctl.MethodSubmit {
			t.Fatalf("namer submitted %q upstream; titles must never touch ajent names",
				string(req.Params))
		}
	}
}

func TestNamerSkippedWithoutBin(t *testing.T) {
	store := newTitleMemStore()
	m, home := newTestFleetWithTitles(t, store)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01NOBINNAME000000"})
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)

	assert.Empty(t, store.snapshot()) // no configured binary, nothing to run
}

// newTestFleetWithTitlesAndBin starts a fast manager with titles and the
// one-shot labeler's binary configured.
func newTestFleetWithTitlesAndBin(t *testing.T, store TitleStore, bin string, owned func(ctl.Instance) bool) (*Manager, string) {
	t.Helper()
	home := testutil.IsolateHome(t)
	m := New(Options{
		Log:          testLogger(),
		PollInterval: testPoll,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		AjentBin:     bin,
		Owned:        owned,
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
