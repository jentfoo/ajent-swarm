package fleet

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// newParkFleet starts a manager whose park window is tuned for tests.
func newParkFleet(t *testing.T, window time.Duration) (*Manager, *fleettest.Stub) {
	t.Helper()
	home := testutil.IsolateHome(t)
	m := New(Options{
		Log:            testLogger(),
		PollInterval:   testPoll,
		BackoffBase:    testBackoff,
		BackoffMax:     testBackoffHi,
		ParkIdleWindow: window,
	})
	m.Start(t.Context())
	t.Cleanup(m.Stop)
	f := fleettest.New(t, home, fleettest.Options{SessionID: "01PARKSESSION000000"})
	f.SetSnapshot(ctl.State{Session: ctl.Session{ID: f.SessionID()}})
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)
	return m, f
}

// submittedLines reads every submit the stub served.
func submittedLines(f *fleettest.Stub) []string {
	var lines []string
	for _, req := range f.Received() {
		if req.Method != ctl.MethodSubmit {
			continue
		}
		var p ctl.SubmitParams
		if json.Unmarshal(req.Params, &p) == nil {
			lines = append(lines, p.Line)
		}
	}
	return lines
}

// waitForRunning blocks until the listing row reports the session's busy flag.
func waitForRunning(t *testing.T, m *Manager, f *fleettest.Stub, running bool) {
	t.Helper()
	require.Eventually(t, func() bool {
		for _, s := range m.Sessions() {
			if s.SessionID == f.SessionID() {
				return s.Running == running
			}
		}
		return false
	}, 2*time.Second, testPoll)
}

func TestPark(t *testing.T) {
	t.Run("idle_session_waits_out_one_window", func(t *testing.T) {
		m, f := newParkFleet(t, 80*time.Millisecond)
		// no known activity, but the park itself still lives one window so the
		// queued state is observable and recallable
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "hello"}))
		require.Never(t, func() bool { return len(submittedLines(f)) > 0 }, 40*time.Millisecond, 10*time.Millisecond)
		require.Eventually(t, func() bool {
			return len(submittedLines(f)) == 1
		}, 2*time.Second, testPoll)
	})

	t.Run("busy_session_waits_for_quiet", func(t *testing.T) {
		m, f := newParkFleet(t, 80*time.Millisecond)
		f.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, f, true) // the park must arm against the live turn
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "later"}))
		f.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})

		// the flush only lands once the turn end has aged past the window
		require.Never(t, func() bool { return len(submittedLines(f)) > 0 }, 40*time.Millisecond, 10*time.Millisecond)
		require.Eventually(t, func() bool {
			return len(submittedLines(f)) == 1
		}, 2*time.Second, testPoll)
	})

	t.Run("quiet_fleet_drips_one_line_per_window", func(t *testing.T) {
		m, f := newParkFleet(t, 150*time.Millisecond)
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "first"}))
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "second"}))

		// the oldest line lands alone at the first idle point
		require.Eventually(t, func() bool { return len(submittedLines(f)) == 1 }, 2*time.Second, testPoll)
		// the second waits out its own window instead of riding the same one
		require.Never(t, func() bool { return len(submittedLines(f)) > 1 }, 100*time.Millisecond, testPoll)
		require.Eventually(t, func() bool { return len(submittedLines(f)) == 2 }, 2*time.Second, testPoll)
	})

	t.Run("released_turn_holds_the_rest", func(t *testing.T) {
		m, f := newParkFleet(t, 150*time.Millisecond)
		first := true
		f.OnSubmit(func(_ ctl.SubmitParams) { // the released line starts a turn
			if first {
				first = false
				f.Broadcast(ctl.EventTurnStart, nil)
			}
		})
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "first"}))
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "second"}))

		require.Eventually(t, func() bool { return len(submittedLines(f)) == 1 }, 2*time.Second, testPoll)
		waitForRunning(t, m, f, true)
		// the running turn keeps every later line parked past two whole windows
		require.Never(t, func() bool { return len(submittedLines(f)) > 1 }, 300*time.Millisecond, testPoll)

		f.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		// and after it ends the next line still waits one full quiet window
		require.Never(t, func() bool { return len(submittedLines(f)) > 1 }, 75*time.Millisecond, testPoll)
		require.Eventually(t, func() bool { return len(submittedLines(f)) == 2 }, 2*time.Second, testPoll)
	})

	t.Run("one_idle_point_across_sessions", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		m := New(Options{
			Log:            testLogger(),
			PollInterval:   testPoll,
			BackoffBase:    testBackoff,
			BackoffMax:     testBackoffHi,
			ParkIdleWindow: 120 * time.Millisecond,
		})
		m.Start(t.Context())
		t.Cleanup(m.Stop)

		stubs := make([]*fleettest.Stub, 0, 2)
		for i, sid := range []string{"01PARKSESSION000000", "01PARKSESSION000001"} {
			f := fleettest.New(t, home, fleettest.Options{SessionID: sid,
				Token: fmt.Sprintf("token%d", i)})
			f.SetSnapshot(ctl.State{Session: ctl.Session{ID: f.SessionID()}})
			f.WriteRegistry(t, os.Getpid(), time.Now())
			waitForState(t, m, f.SessionID(), ChildOnline)
			stubs = append(stubs, f)
		}

		for i, f := range stubs {
			require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(),
				ctl.SubmitParams{Line: fmt.Sprintf("line %d", i)}))
			f.Broadcast(ctl.EventTurnStart, nil) // hold both behind the live turns
		}
		for _, f := range stubs {
			waitForRunning(t, m, f, true)
		}
		for _, f := range stubs { // both end together: one shared quiet point
			f.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		}

		flushed := func() int {
			n := 0
			for _, f := range stubs {
				n += len(submittedLines(f))
			}
			return n
		}
		require.Eventually(t, func() bool { return flushed() == 1 }, 2*time.Second, testPoll)
		// the loser re-arms behind the winner instead of riding its idle point
		require.Never(t, func() bool { return flushed() > 1 },
			60*time.Millisecond, testPoll)
		require.Eventually(t, func() bool { return flushed() == 2 }, 2*time.Second, testPoll)
	})

	t.Run("parked_facts_reach_the_digest", func(t *testing.T) {
		m, f := newParkFleet(t, time.Hour)   // hold the flush, read the digest
		f.Broadcast(ctl.EventTurnStart, nil) // busy: the row reads working
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "queued prompt"}))

		rows := m.Sessions()
		require.Eventually(t, func() bool {
			rows = m.Sessions()
			for _, s := range rows {
				if s.SessionID == f.SessionID() {
					return s.Parked == 1
				}
			}
			return false
		}, 2*time.Second, testPoll)
		for _, s := range rows {
			if s.SessionID == f.SessionID() {
				assert.Equal(t, "queued prompt", s.ParkedPrompt)
				assert.Positive(t, s.ParkedAt)
			}
		}

		digest := m.Attention()
		require.Len(t, digest, 1)
		assert.Equal(t, AttentionWorking, digest[0].Kind)
		assert.Equal(t, "queued: queued prompt", digest[0].Reason)
	})

	t.Run("parked_rows_reach_snapshot_and_init", func(t *testing.T) {
		m, f := newParkFleet(t, time.Hour) // hold the flush, read the payloads
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "queued prompt", PendingID: "p1"}))
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "secret: hunter2", PendingID: "p2"}))

		st, err := m.Snapshot(t.Context(), f.SessionID())
		require.NoError(t, err)
		assert.Equal(t, []ctl.QueueRow{
			{ID: "p1", Text: "queued prompt"},
			{ID: "p2"}, // secrets redact to their id
		}, st.ParkedRows)

		// a freshly subscribing client learns the same list through its init
		frames := make(chan []byte, 4)
		sub, err := m.Subscribe(f.SessionID(), func(b []byte) { frames <- b }, func() {})
		require.NoError(t, err)
		t.Cleanup(func() { m.Unsubscribe(sub) })
		select {
		case raw := <-frames:
			var frame InitFrame
			require.NoError(t, json.Unmarshal(raw, &frame))
			assert.Equal(t, st.ParkedRows, frame.State.ParkedRows)
		case <-time.After(2 * time.Second):
			t.Fatal("no init frame arrived")
		}
	})

	t.Run("recall_pops_the_newest", func(t *testing.T) {
		m, f := newParkFleet(t, time.Hour)
		f.Broadcast(ctl.EventTurnStart, nil) // hold the flush behind a live turn
		waitForRunning(t, m, f, true)
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "first"}))
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "second"}))

		params, ok, err := m.QueueRecall(t.Context(), f.SessionID())
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, "second", params.Line)

		_, ok, err = m.QueueRecall(t.Context(), f.SessionID())
		require.NoError(t, err)
		assert.True(t, ok) // "first" is still parked

		_, ok, err = m.QueueRecall(t.Context(), f.SessionID())
		require.NoError(t, err)
		assert.False(t, ok) // drained
	})

	t.Run("cap_refuses_extra_lines", func(t *testing.T) {
		m, f := newParkFleet(t, time.Hour)
		f.Broadcast(ctl.EventTurnStart, nil) // hold the flush behind a live turn
		waitForRunning(t, m, f, true)
		for range maxParked {
			require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "x"}))
		}
		err := m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "one too many"})
		require.Error(t, err)
		var ce *ctl.Error
		require.ErrorAs(t, err, &ce)
		assert.Equal(t, ctl.CodeBadRequest, ce.Code)
	})

	t.Run("exit_clears_parked_lines", func(t *testing.T) {
		m, f := newParkFleet(t, time.Hour)
		f.Broadcast(ctl.EventTurnStart, nil) // hold the flush behind a live turn
		waitForRunning(t, m, f, true)
		require.NoError(t, m.QueueSubmit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "never"}))
		f.Exit("done")
		waitForState(t, m, f.SessionID(), ChildExited)

		for _, s := range m.Sessions() {
			if s.SessionID == f.SessionID() {
				assert.Zero(t, s.Parked)
			}
		}
		assert.Empty(t, submittedLines(f))
	})

	t.Run("unknown_session_refused", func(t *testing.T) {
		m, _ := newParkFleet(t, time.Hour)
		require.ErrorIs(t, m.QueueSubmit(t.Context(), "01NOBODY00000000", ctl.SubmitParams{Line: "hi"}), ErrUnknownSession)
		_, _, err := m.QueueRecall(t.Context(), "01NOBODY00000000")
		require.ErrorIs(t, err, ErrUnknownSession)
	})
}
