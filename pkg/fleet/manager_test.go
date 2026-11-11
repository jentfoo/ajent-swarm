package fleet

import (
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/paths"
	"github.com/jentfoo/ajent/pkg/session"
)

// testLogger silences fleet logs during tests.
func testLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

// deadPID returns a process id that provably answers no signals anymore: the
// child ran, was reaped, and its pid is free.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^$")
	require.NoError(t, cmd.Run())
	return cmd.Process.Pid
}

// Test timings: the fleet cadence tests run at.
const (
	testPoll      = 10 * time.Millisecond
	testBackoff   = 5 * time.Millisecond
	testBackoffHi = 50 * time.Millisecond
)

// newTestFleet pins AJENT_HOME to a temp dir and starts a fast manager.
// The home stays short: unix socket paths cap at ~108 bytes, and t.TempDir
// names grow with the test name.
func newTestFleet(t *testing.T, owned func(inst ctl.Instance) bool) (*Manager, string) {
	t.Helper()
	home := testutil.IsolateHome(t)
	m := New(Options{
		Log:          testLogger(),
		PollInterval: testPoll,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		Owned:        owned,
	})
	m.Start(t.Context())
	t.Cleanup(m.Stop)
	return m, home
}

// externalFleet starts a manager over a stubbed discovery feed and a fake
// child store. The watch idles: retention tests drive diff() by hand.
func externalFleet(t *testing.T, cs *fakeChildStore, live func() ([]ctl.Instance, error)) *Manager {
	t.Helper()
	m := New(Options{
		Log:          testLogger(),
		PollInterval: time.Hour,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		ChildStore:   cs,
		Discover:     live,
	})
	m.Start(t.Context())
	t.Cleanup(m.Stop)
	return m
}

// subscribeTest registers one test viewer, frames flow into the channel.
func subscribeTest(t *testing.T, m *Manager, sessionID string) (*Subscription, <-chan []byte) {
	t.Helper()
	out := make(chan []byte, 256)
	var sub *Subscription
	require.Eventually(t, func() bool { // discovery may not have run yet
		s, err := m.Subscribe(sessionID, func(b []byte) { out <- b }, func() {})
		if err != nil {
			return false
		}
		sub = s
		return true
	}, 2*time.Second, testPoll)
	t.Cleanup(func() { m.Unsubscribe(sub) })
	return sub, out
}

// frame is one raw stream frame beside its decoded envelope.
type frame struct {
	raw []byte
	env wire
}

// readFrame pulls one frame, a stall fails through the Eventually window.
func readFrame(t *testing.T, in <-chan []byte) frame {
	t.Helper()
	var b []byte
	require.Eventually(t, func() bool {
		select {
		case b = <-in:
			return true
		default:
			return false
		}
	}, 2*time.Second, time.Millisecond)
	var f wire
	require.NoError(t, json.Unmarshal(b, &f))
	return frame{raw: b, env: f}
}

// expectFrame drains frames until one of the wanted type arrives.
func expectFrame(t *testing.T, in <-chan []byte, want string) frame {
	t.Helper()
	for range 50 {
		f := readFrame(t, in)
		if f.env.Type == want {
			return f
		}
	}
	t.Fatalf("no %s frame arrived", want)
	return frame{}
}

// expectChildState drains frames until one child frame names want, since a
// loss and its manager cleanup may interleave either way.
func expectChildState(t *testing.T, in <-chan []byte, want string) {
	t.Helper()
	for range 50 {
		f := readFrame(t, in)
		if f.env.Type == FrameChild && f.env.childState() == want {
			return
		}
	}
	t.Fatalf("no child frame reached state %s", want)
}

// wire decodes the envelope of any stream frame. State is polymorphic: a
// child state string on child frames, the snapshot object on inits.
type wire struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId"`
	State     json.RawMessage `json:"state,omitempty"`
	Detail    string          `json:"detail,omitempty"`
	Code      string          `json:"code,omitempty"`
	Event     ctl.Event       `json:"event,omitempty"`
}

// childState names the lifecycle state on a child frame.
func (f wire) childState() string {
	var state string
	_ = json.Unmarshal(f.State, &state)
	return state
}

// stubEntries builds a two-entry transcript branch.
func stubEntries() (session.Entry, session.Entry) {
	first := session.Entry{ID: "01STUBENTRYA000000000", Type: session.TypeSession,
		Data: mustJSON(session.SessionData{Version: 1})}
	second := session.Entry{ID: "01STUBENTRYB000000000", ParentID: first.ID,
		Type: session.TypeMessage, Data: mustJSON(session.MessageData{
			Message: llm.Text(llm.RoleUser, "hello fleet"),
		})}
	return first, second
}

func waitForState(t *testing.T, m *Manager, sessionID, state string) {
	t.Helper()
	require.Eventually(t, func() bool {
		for _, s := range m.Sessions() {
			if s.SessionID == sessionID && s.State == state {
				return true
			}
		}
		return false
	}, 2*time.Second, testPoll)
}
func TestManager(t *testing.T) {
	t.Run("attaches_and_serves_init", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01STUBSESSION00000000", Name: "fleet-test"})
		first, second := stubEntries()
		f.SetSnapshot(ctl.State{
			Session:    ctl.Session{ID: f.SessionID()},
			Model:      ctl.ModelState{Key: "p/m"},
			Running:    true,
			QueuedRows: []ctl.QueueRow{{ID: "c1", Text: "queued"}},
		})
		f.WriteTranscript(t, first, second)
		f.WriteRegistry(t, os.Getpid(), time.Now())

		_, out := subscribeTest(t, m, f.SessionID())
		waitForState(t, m, f.SessionID(), ChildOnline)

		init := expectFrame(t, out, FrameInit)
		var msg InitFrame
		require.NoError(t, json.Unmarshal(init.raw, &msg))
		assert.Equal(t, f.SessionID(), msg.SessionID)
		assert.Equal(t, "p/m", msg.State.Model.Key)
		assert.True(t, msg.State.Running)
		assert.Equal(t, second.ID, msg.State.Head)
		require.Len(t, msg.Entries, 2) // committed history from the transcript
		assert.Equal(t, first.ID, msg.Entries[0].ID)
		assert.Empty(t, msg.Cursor) // short history: nothing paged off

		// a live event flows through verbatim with its seq
		f.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: true})
		ev := expectFrame(t, out, FrameEvent)
		assert.Equal(t, ctl.EventIdle, ev.env.Event.Name)
	})

	t.Run("seat_policy", func(t *testing.T) {
		t.Run("owned_force_claims_seat", func(t *testing.T) {
			m, home := newTestFleet(t, func(inst ctl.Instance) bool { return inst.SessionID == "01OWNED00000000000" })
			f := fleettest.New(t, home, fleettest.Options{SessionID: "01OWNED00000000000"})
			f.WriteRegistry(t, os.Getpid(), time.Now())

			waitForState(t, m, f.SessionID(), ChildOnline)
			assert.Equal(t, holderName, f.SeatHolder())
		})

		t.Run("external_sessions_stay_observers", func(t *testing.T) {
			m, home := newTestFleet(t, nil)
			f := fleettest.New(t, home, fleettest.Options{SessionID: "01EXTERNAL00000000"})
			f.WriteRegistry(t, os.Getpid(), time.Now())

			waitForState(t, m, f.SessionID(), ChildOnline)
			assert.Empty(t, f.SeatHolder()) // a human --attach is never displaced
		})
	})

	t.Run("force_claims_once", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01TAKECTRL00000000"})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		require.NoError(t, m.TakeControl(t.Context(), f.SessionID()))
		assert.Equal(t, holderName, f.SeatHolder())

		// seat policy never re-forces on its own: a displaced holder keeps the
		// seat until an explicit command takes it back
		f.Broadcast(ctl.EventNotice, ctl.NoticeData{Text: "n"})
		require.NoError(t, m.TakeControl(t.Context(), f.SessionID()))
		assert.Equal(t, holderName, f.SeatHolder())
	})

	t.Run("surfaces_seat_held", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01REFUSED000000000", Refuses: true})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		err := m.TakeControl(t.Context(), f.SessionID())
		require.Error(t, err)
		var wire *ctl.Error
		require.ErrorAs(t, err, &wire)
		assert.Equal(t, ctl.CodeSeatHeld, wire.Code) // the UI renders the holder from this
	})

	t.Run("exit_ends_tracking_cleanly", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01EXITING00000000"})
		first, second := stubEntries()
		f.WriteTranscript(t, first, second)
		f.WriteRegistry(t, os.Getpid(), time.Now())

		_, out := subscribeTest(t, m, f.SessionID())
		waitForState(t, m, f.SessionID(), ChildOnline)

		dials := f.DialCount()
		f.Exit("all done")

		// the exit event reaches viewers verbatim, then the synthesized child
		// frame names the clean end with its reason
		ev := expectFrame(t, out, FrameEvent)
		assert.Equal(t, ctl.EventSessionExit, ev.env.Event.Name)
		child := expectFrame(t, out, FrameChild)
		assert.Equal(t, ChildExited, child.env.childState())
		assert.Equal(t, "all done", child.env.Detail)

		waitForState(t, m, f.SessionID(), ChildExited)
		// no redial follows a clean exit: the actor idles on its final view
		require.Never(t, func() bool { return f.DialCount() != dials },
			60*time.Millisecond, testPoll)
	})

	t.Run("exit_mid_turn_settles_the_final_view", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01UNSETTLED000000"})
		first, second := stubEntries()
		f.WriteTranscript(t, first, second)
		f.WriteRegistry(t, os.Getpid(), time.Now())

		_, out := subscribeTest(t, m, f.SessionID())
		waitForState(t, m, f.SessionID(), ChildOnline)

		// the turn never settles: no turn.end follows the exit
		f.Broadcast(ctl.EventTurnStart, ctl.TurnStartData{Model: "p/m"})
		spin := true
		f.Broadcast(ctl.EventStatus, ctl.StatusData{Spinning: &spin})
		f.Exit("transaction unsettled")
		expectFrame(t, out, FrameChild)
		waitForState(t, m, f.SessionID(), ChildExited)

		// a late subscriber's greeting carries the settled view, and the
		// listing never badges a dead session as running
		_, late := subscribeTest(t, m, f.SessionID())
		init := expectFrame(t, late, FrameInit)
		var msg InitFrame
		require.NoError(t, json.Unmarshal(init.raw, &msg))
		assert.False(t, msg.State.Running)
		assert.False(t, msg.State.Spinning)

		for _, s := range m.Sessions() {
			if s.SessionID == f.SessionID() {
				assert.False(t, s.Running)
			}
		}
	})

	t.Run("reconnect_resnapshots_without_duplicates", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01DROPPING0000000"})
		first, second := stubEntries()
		f.WriteTranscript(t, first, second)
		f.WriteRegistry(t, os.Getpid(), time.Now())

		_, out := subscribeTest(t, m, f.SessionID())
		waitForState(t, m, f.SessionID(), ChildOnline)

		f.DropConns() // lost, not exited: the reconnect loop starts
		child := expectFrame(t, out, FrameChild)
		assert.Equal(t, ChildReconnecting, child.env.childState())

		require.Eventually(t, func() bool { return f.DialCount() >= 2 }, 2*time.Second, testPoll)
		online := expectFrame(t, out, FrameChild)
		assert.Equal(t, ChildOnline, online.env.childState())

		// the rebuilt view carries one copy of every committed entry
		page, _, err := m.Entries(t.Context(), f.SessionID(), "", 100)
		require.NoError(t, err)
		assert.Len(t, page, 2) // backfill plus overlapping live appends dedupe by id
	})

	t.Run("follows_a_restarted_instance", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		old := fleettest.New(t, home, fleettest.Options{SessionID: "01RESTART00000000"})
		first, second := stubEntries()
		old.WriteTranscript(t, first, second)
		old.WriteRegistry(t, os.Getpid(), time.Now())

		_, out := subscribeTest(t, m, old.SessionID())
		waitForState(t, m, old.SessionID(), ChildOnline)

		// the process dies and a new serve run of the same session comes up under
		// its own token: the manager stops the old actor (child gone), adopts the
		// replacement and migrates the subscription onto it with a fresh init
		old.RemoveRegistry()
		replacement := fleettest.New(t, home, fleettest.Options{SessionID: "01RESTART00000000", Token: "token5678"})
		replacement.WriteTranscript(t, first, second)
		replacement.WriteRegistry(t, os.Getpid(), time.Now())
		old.DropConns()
		expectChildState(t, out, ChildGone)

		init := expectFrame(t, out, FrameInit) // the migrated subscription resnapshots
		var msg InitFrame
		require.NoError(t, json.Unmarshal(init.raw, &msg))
		assert.Equal(t, old.SessionID(), msg.SessionID)
		assert.Equal(t, second.ID, msg.State.Head)

		// events now flow from the replacement
		replacement.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: true})
		ev := expectFrame(t, out, FrameEvent)
		assert.Equal(t, ctl.EventIdle, ev.env.Event.Name)
	})

	t.Run("never_dials_dead_record", func(t *testing.T) {
		m, home := newTestFleet(t, nil)

		// a record whose pid is provably dead and old enough to judge: discovery
		// filters it before any dial could happen
		dir := filepath.Join(home, paths.ControlDirName, "01DEADPID00000000")
		require.NoError(t, os.MkdirAll(dir, 0o700))
		record := `{"sessionID":"01DEADPID00000000","pid":` + strconv.Itoa(deadPID(t)) +
			`,"startedAt":` + strconv.FormatInt(time.Now().Add(-2*time.Minute).UnixMilli(), 10) +
			`,"token":"deadbeef","socket":"/nonexistent/none.sock"}`
		require.NoError(t, os.WriteFile(filepath.Join(dir, "deadbeef.json"), []byte(record), 0o600))

		// discovery keeps passing over the record for many polls without ever
		// tracking it: InstanceDead filters it before any dial could happen
		require.Never(t, func() bool { return len(m.Sessions()) > 0 },
			60*time.Millisecond, testPoll)
	})

	t.Run("unknown_session_subscribe_fails_fast", func(t *testing.T) {
		m, _ := newTestFleet(t, nil)
		_, err := m.Subscribe("01NOBODY00000000000", func([]byte) {}, func() {})
		require.ErrorIs(t, err, ErrUnknownSession)
	})

	t.Run("two_viewers_see_identical_state", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01TWOWATCH0000000", Name: "two"})
		first, second := stubEntries()
		f.SetSnapshot(ctl.State{
			Session:    ctl.Session{ID: f.SessionID()},
			Model:      ctl.ModelState{Key: "p/m"},
			QueuedRows: []ctl.QueueRow{{ID: "c1", Text: "queued"}},
		})
		f.WriteTranscript(t, first, second)
		f.WriteRegistry(t, os.Getpid(), time.Now())

		_, outA := subscribeTest(t, m, f.SessionID())
		_, outB := subscribeTest(t, m, f.SessionID())
		waitForState(t, m, f.SessionID(), ChildOnline)

		// both subscribers reconcile to the same snapshot and the same entries
		inits := make([]InitFrame, 0, 2)
		for _, out := range []<-chan []byte{outA, outB} {
			raw := expectRaw(t, out, FrameInit)
			var msg InitFrame
			require.NoError(t, json.Unmarshal(raw, &msg))
			inits = append(inits, msg)
		}
		require.Len(t, inits, 2)
		assert.Equal(t, inits[0].State, inits[1].State)
		assert.Equal(t, inits[0].Entries, inits[1].Entries)

		// live events fan out to both, verbatim and in order
		f.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: true})
		for _, out := range []<-chan []byte{outA, outB} {
			ev := expectFrame(t, out, FrameEvent)
			assert.Equal(t, ctl.EventIdle, ev.env.Event.Name)
		}
	})

	t.Run("listing_carries_queue_depth", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01QUEUEDEPTH00000"})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		st, ok := rowFor(m.Sessions(), f.SessionID())
		require.True(t, ok)
		assert.Zero(t, st.Queued) // nothing queued at attach

		f.Broadcast(ctl.EventQueued, ctl.QueuedData{Rows: []ctl.QueueRow{
			{ID: "c1", Text: "first"}, {ID: "c2", Text: "second"},
		}})
		require.Eventually(t, func() bool {
			st, ok := rowFor(m.Sessions(), f.SessionID())
			return ok && st.Queued == 2 // queued replaces wholesale and the listing follows
		}, 2*time.Second, testPoll)

		f.Broadcast(ctl.EventQueueDropped, ctl.QueueDroppedData{Rows: []ctl.QueueRow{{ID: "c1"}}})
		require.Eventually(t, func() bool {
			st, ok := rowFor(m.Sessions(), f.SessionID())
			return ok && st.Queued == 1
		}, 2*time.Second, testPoll)
	})

	t.Run("session_rows", func(t *testing.T) {
		t.Run("keeps_exited_pinned", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			now := time.Now()
			for _, rec := range []ChildRecord{
				exitedRec("01EXITMID0000000000", 4202, now.Add(-time.Minute)), // the newer exit
				exitedRec("01EXITOLD0000000000", 4201, now.Add(-2*time.Minute)),
			} {
				m.children[rec.PID] = &childProc{rec: rec}
			}
			live := &sessionActor{}
			live.key.sessionID = "01LIVESESSION000000"
			live.status.Store(&Status{
				digestFacts: digestFacts{SessionID: live.key.sessionID},
				State:       ChildOnline,
				SpawnedBy:   SpawnedBySwarm,
			})
			m.actors[actorKey{sessionID: live.key.sessionID, token: "t"}] = live

			rows := m.Sessions()
			require.Len(t, rows, 3)
			// alive sorts before exited ones, ended rows run most-recent-first
			assert.Equal(t, "01LIVESESSION000000", rows[0].SessionID)
			assert.Equal(t, ChildOnline, rows[0].State)
			assert.Equal(t, "01EXITMID0000000000", rows[1].SessionID)
			assert.Equal(t, ChildExited, rows[1].State)
			assert.Equal(t, "01EXITOLD0000000000", rows[2].SessionID)
		})

		t.Run("lists_running_twins", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			// two processes serving one session: a resume of an already running run
			for _, pid := range []int{4801, 4802} {
				live := &sessionActor{}
				live.key.sessionID = "01TWINRESUME000001"
				live.status.Store(&Status{
					digestFacts: digestFacts{SessionID: live.key.sessionID, PID: pid},
					State:       ChildOnline,
				})
				m.actors[actorKey{sessionID: live.key.sessionID, token: strconv.Itoa(pid)}] = live
			}

			rows := m.Sessions()
			require.Len(t, rows, 2)
			// same session id twice, told apart by pid and ordered stably
			assert.Equal(t, ChildOnline, rows[0].State)
			assert.Equal(t, ChildOnline, rows[1].State)
			assert.Less(t, rows[0].PID, rows[1].PID)
		})

		t.Run("keeps_every_recent_exit", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			now := time.Now()
			for i := range 6 {
				rec := exitedRec(
					string(rune('A'+i))+"-session-padding0", 4301+i, now.Add(-time.Duration(i)*time.Minute))
				m.children[rec.PID] = &childProc{rec: rec}
			}

			rows := m.Sessions()
			require.Len(t, rows, 6) // all inside the recent window, however many
			assert.Equal(t, "A-session-padding0", rows[0].SessionID)
		})

		t.Run("caps_old_exits_at_minimum", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			now := time.Now()
			for i := range 6 {
				rec := exitedRec(
					string(rune('A'+i))+"-session-padding0", 4301+i,
					now.Add(-endedKeepWindow-time.Duration(i)*time.Minute))
				m.children[rec.PID] = &childProc{rec: rec}
			}

			rows := m.Sessions()
			require.Len(t, rows, maxExitedPinned)
			// the newest four survive, the two oldest dropped off
			assert.Equal(t, "A-session-padding0", rows[0].SessionID)
			assert.Equal(t, "D-session-padding0", rows[maxExitedPinned-1].SessionID)
		})

		t.Run("keeps_recent_beyond_minimum", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			now := time.Now()
			for i := range 5 { // inside the window, newest first
				rec := exitedRec(
					string(rune('A'+i))+"-session-recent0", 4401+i, now.Add(-time.Duration(i)*time.Minute))
				m.children[rec.PID] = &childProc{rec: rec}
			}
			for i := range 2 { // well past the window
				rec := exitedRec(
					string(rune('M'+i))+"-session-stale00", 4501+i,
					now.Add(-endedKeepWindow-time.Duration(i)*time.Hour))
				m.children[rec.PID] = &childProc{rec: rec}
			}

			rows := m.Sessions()
			require.Len(t, rows, 5) // the pinned minimum plus every newer exit
			assert.Equal(t, "A-session-recent0", rows[0].SessionID)
			assert.Equal(t, "E-session-recent0", rows[4].SessionID)
		})

		t.Run("hides_replaced_exited_rows", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			now := time.Now()
			old := &childProc{rec: exitedRec("01SESSIONREUSED0000", 4401, now.Add(-time.Hour))}
			m.children[old.rec.PID] = old
			replacement := &sessionActor{}
			replacement.key.sessionID = "01SESSIONREUSED0000"
			replacement.status.Store(&Status{
				digestFacts: digestFacts{SessionID: replacement.key.sessionID},
				State:       ChildOnline,
			})
			m.actors[actorKey{sessionID: replacement.key.sessionID, token: "t"}] = replacement

			rows := m.Sessions()
			require.Len(t, rows, 1)
			assert.Equal(t, ChildOnline, rows[0].State) // the live instance owns the row
		})

		t.Run("external_rows_read_as_external", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			now := time.Now()
			m.externals[4601] = ChildRecord{
				PID: 4601, SessionID: "01EXTENDED00000001", SessionName: "daily",
				Workspace: "/w", Origin: SpawnedByExternal,
				StartedAt: now.Add(-time.Hour), ExitedAt: now,
				ExitNote: "ended on its own",
			}

			rows := m.Sessions()
			require.Len(t, rows, 1)
			st := rows[0]
			assert.Equal(t, SpawnedByExternal, st.SpawnedBy)
			assert.Equal(t, ChildExited, st.State)
			assert.Equal(t, "ended on its own", st.Detail)
			assert.Equal(t, "daily", st.Name)
			assert.Nil(t, st.ExitCode) // swarm never reaped the process
			assert.Empty(t, st.Argv)   // externals have neither spawn fact
			assert.Empty(t, st.LogPath)
		})

		t.Run("live_row_ignores_stale_record", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			now := time.Now()
			// an older instance's exited record beside its resumed replacement
			m.children[4701] = &childProc{rec: ChildRecord{
				PID: 4701, SessionID: "01RESUMED000000001", Workspace: "/w",
				StartedAt: now.Add(-2 * time.Hour), ExitedAt: now.Add(-time.Hour),
				ExitNote: "exited",
			}}
			live := &sessionActor{}
			live.key.sessionID = "01RESUMED000000001"
			live.status.Store(&Status{
				digestFacts: digestFacts{SessionID: live.key.sessionID, PID: 4702},
				State:       ChildOnline,
			})
			m.actors[actorKey{sessionID: live.key.sessionID, token: "t"}] = live
			m.externals[4702] = ChildRecord{
				PID: 4702, SessionID: "01RESUMED000000001", SessionName: "daily",
				Workspace: "/w", Origin: SpawnedByExternal, StartedAt: now.Add(-time.Minute),
			}

			rows := m.Sessions()
			require.Len(t, rows, 1)
			st := rows[0]
			assert.Equal(t, ChildOnline, st.State)
			assert.Zero(t, st.ExitedAt) // the stale exit never decorates the live row
			assert.Equal(t, SpawnedByExternal, st.SpawnedBy)
		})
	})

	t.Run("external_retention", func(t *testing.T) {
		inst := ctl.Instance{
			SessionID:   "01EXTRETAIN00000001",
			SessionName: "daily-driver",
			Workspace:   "/repo",
			StartedAt:   time.Now().Add(-time.Minute).UnixMilli(),
			PID:         os.Getpid(),
			Token:       "exttok1",
			Socket:      "/nonexistent/external.sock",
		}

		t.Run("gains_row_at_first_sighting", func(t *testing.T) {
			cs := newFakeChildStore()
			live := true
			m := externalFleet(t, cs, func() ([]ctl.Instance, error) {
				if !live {
					return nil, nil
				}
				return []ctl.Instance{inst}, nil
			})

			require.NoError(t, m.diff()) // the sighting retains and tracks the instance

			st, ok := rowFor(m.Sessions(), inst.SessionID)
			require.True(t, ok)
			assert.Equal(t, SpawnedByExternal, st.SpawnedBy)
			assert.Equal(t, inst.Workspace, st.Workspace)
			assert.Equal(t, inst.SessionName, st.Name)
			assert.Equal(t, ChildReconnecting, st.State) // tracked, though dialing fails
			assert.Zero(t, st.ExitedAt)

			rec, ok := cs.byPID(inst.PID)
			require.True(t, ok)
			assert.Equal(t, SpawnedByExternal, rec.Origin)
			assert.Equal(t, inst.SessionID, rec.SessionID)
			assert.Equal(t, inst.SessionName, rec.SessionName)
			assert.Equal(t, inst.Workspace, rec.Workspace)
			assert.Equal(t, inst.Started(), rec.StartedAt)
			assert.True(t, rec.ExitedAt.IsZero())
			assert.Empty(t, rec.Argv)
			assert.Empty(t, rec.LogPath)

			require.NoError(t, m.diff()) // repeated passes never duplicate the row
			rows, err := cs.Children(t.Context())
			require.NoError(t, err)
			require.Len(t, rows, 1)
		})

		t.Run("drop_marks_the_row_exited", func(t *testing.T) {
			cs := newFakeChildStore()
			live := true
			m := externalFleet(t, cs, func() ([]ctl.Instance, error) {
				if !live {
					return nil, nil
				}
				return []ctl.Instance{inst}, nil
			})

			require.NoError(t, m.diff())
			live = false                 // the record left discovery
			require.NoError(t, m.diff()) // tracking ends, the row stays listed as ended

			st, ok := rowFor(m.Sessions(), inst.SessionID)
			require.True(t, ok)
			assert.Equal(t, ChildExited, st.State)
			assert.Equal(t, "ended on its own", st.Detail)
			assert.Equal(t, SpawnedByExternal, st.SpawnedBy)
			assert.Positive(t, st.ExitedAt)
			assert.Nil(t, st.ExitCode)

			rec, ok := cs.byPID(inst.PID)
			require.True(t, ok)
			assert.False(t, rec.ExitedAt.IsZero())
			assert.Equal(t, "ended on its own", rec.ExitNote)
			assert.Nil(t, rec.ExitCode)
		})

		t.Run("empty_served_run_dropped", func(t *testing.T) {
			home := testutil.IsolateHome(t)
			const sid = "01EXTSERVED0000001"
			stub := fleettest.New(t, home, fleettest.Options{SessionID: sid})
			ext := ctl.Instance{
				SessionID: sid, Workspace: "/repo", PID: os.Getpid(),
				StartedAt: time.Now().Add(-time.Minute).UnixMilli(),
				Token:     "token1234", Socket: stub.Path(),
			}
			cs := newFakeChildStore()
			live := true
			m := externalFleet(t, cs, func() ([]ctl.Instance, error) {
				if !live {
					return nil, nil
				}
				return []ctl.Instance{ext}, nil
			})

			require.NoError(t, m.diff()) // retained and tracked
			require.Eventually(t, func() bool {
				st, ok := rowFor(m.Sessions(), sid)
				return ok && st.State == ChildOnline // the actor served a real view
			}, 3*time.Second, testPoll)

			live = false                 // the record left discovery
			require.NoError(t, m.diff()) // the empty run drops instead of tombstoning

			_, ok := rowFor(m.Sessions(), sid)
			assert.False(t, ok)
			_, ok = cs.byPID(ext.PID)
			assert.False(t, ok)
		})

		t.Run("named_served_run_tombstoned", func(t *testing.T) {
			home := testutil.IsolateHome(t)
			const sid = "01EXTNAMED000000001"
			stub := fleettest.New(t, home, fleettest.Options{SessionID: sid, Name: "daily"})
			ext := ctl.Instance{
				SessionID: sid, SessionName: "daily", Workspace: "/repo", PID: os.Getpid(),
				StartedAt: time.Now().Add(-time.Minute).UnixMilli(),
				Token:     "token1234", Socket: stub.Path(),
			}
			cs := newFakeChildStore()
			live := true
			m := externalFleet(t, cs, func() ([]ctl.Instance, error) {
				if !live {
					return nil, nil
				}
				return []ctl.Instance{ext}, nil
			})

			require.NoError(t, m.diff())
			require.Eventually(t, func() bool {
				st, ok := rowFor(m.Sessions(), sid)
				return ok && st.State == ChildOnline
			}, 3*time.Second, testPoll)

			live = false
			require.NoError(t, m.diff()) // a named session stays resumable

			st, ok := rowFor(m.Sessions(), sid)
			require.True(t, ok)
			assert.Equal(t, ChildExited, st.State)
			assert.Equal(t, "daily", st.Name)
			rec, ok := cs.byPID(ext.PID)
			require.True(t, ok)
			assert.False(t, rec.ExitedAt.IsZero())
		})

		t.Run("running_external_survives_restart", func(t *testing.T) {
			cs := newFakeChildStore()
			live := func() ([]ctl.Instance, error) { return []ctl.Instance{inst}, nil }

			first := externalFleet(t, cs, live)
			require.NoError(t, first.diff())
			first.Stop()

			second := externalFleet(t, cs, live) // adopt re-loads the running row
			require.NoError(t, second.diff())    // re-tracks without a second row

			st, ok := rowFor(second.Sessions(), inst.SessionID)
			require.True(t, ok)
			assert.Equal(t, ChildReconnecting, st.State)
			assert.Zero(t, st.ExitedAt)

			rec, ok := cs.byPID(inst.PID)
			require.True(t, ok)
			assert.True(t, rec.ExitedAt.IsZero()) // a restart never marks it exited

			rows, err := cs.Children(t.Context())
			require.NoError(t, err)
			require.Len(t, rows, 1)
		})

		t.Run("shutdown_pass_skips_marking", func(t *testing.T) {
			cs := newFakeChildStore()
			live := true
			m := externalFleet(t, cs, func() ([]ctl.Instance, error) {
				if !live {
					return nil, nil
				}
				return []ctl.Instance{inst}, nil
			})

			require.NoError(t, m.diff()) // the instance is tracked and retained
			live = false
			m.cancel() // shutdown lands before the pass that sees the drop
			require.NoError(t, m.diff())

			rec, ok := cs.byPID(inst.PID)
			require.True(t, ok)
			assert.True(t, rec.ExitedAt.IsZero()) // not tombstoned mid-shutdown

			st, ok := rowFor(m.Sessions(), inst.SessionID)
			require.True(t, ok)
			assert.Equal(t, ChildReconnecting, st.State) // still a running row
		})
	})

	t.Run("last_busy_at", func(t *testing.T) {
		actor := func(m *Manager, lastTurnEnd int64, running bool) *sessionActor {
			live := &sessionActor{}
			live.key.sessionID = "01BUSYSESSION0000000"
			live.status.Store(&Status{
				digestFacts: digestFacts{SessionID: live.key.sessionID, LastTurnEnd: lastTurnEnd,
					Running: running},
				State:  ChildOnline,
				served: true, // attached and streaming at least once
			})
			m.actors[actorKey{sessionID: live.key.sessionID, token: "t"}] = live
			return live
		}

		t.Run("aged_turn_end_reported", func(t *testing.T) {
			// a serving session's last turn end is reported however old it is
			m := New(Options{Log: testLogger()})
			now := time.Now()
			actor(m, now.Add(-time.Hour).UnixMilli(), false)
			busy := m.LastBusyAt()
			assert.False(t, busy.IsZero())
			assert.LessOrEqual(t, busy.UnixMilli(), now.Add(-time.Hour).UnixMilli())
		})

		t.Run("running_actor_busy_now", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			actor(m, time.Now().Add(-time.Hour).UnixMilli(), true)
			assert.WithinDuration(t, time.Now(), m.LastBusyAt(), time.Second)
		})

		t.Run("needs_input_actor_not_busy", func(t *testing.T) {
			// a dialog waits on its user, so the aged turn end still bounds idle
			m := New(Options{Log: testLogger()})
			live := actor(m, time.Now().Add(-time.Hour).UnixMilli(), true)
			live.status.Store(&Status{
				digestFacts: digestFacts{SessionID: live.key.sessionID, Running: true, OpenInteractions: 1,
					LastTurnEnd: time.Now().Add(-time.Hour).UnixMilli()},
				State:  ChildOnline,
				served: true,
			})
			busy := m.LastBusyAt()
			assert.False(t, busy.IsZero())
			assert.LessOrEqual(t, busy.UnixMilli(), time.Now().Add(-time.Hour).UnixMilli())
		})

		t.Run("exited_actor_never_busy", func(t *testing.T) {
			m := New(Options{Log: testLogger()})
			live := actor(m, time.Now().Add(-time.Hour).UnixMilli(), true)
			live.status.Store(&Status{
				digestFacts: digestFacts{SessionID: live.key.sessionID, Running: true},
				State:       ChildExited,
				served:      true, // stale flag beside a terminal state still means ended
			})
			assert.True(t, m.LastBusyAt().IsZero())
		})
	})
}

// Exited swarm children stay listed for one-click resume: the four most
// recent pin under the alive rows, most-recent-first, and older ones age out.
func exitedRec(id string, pid int, at time.Time) ChildRecord {
	return ChildRecord{
		SessionID: id,
		PID:       pid,
		Workspace: "/w",
		ExitedAt:  at,
		ExitNote:  "exited",
	}
}

func expectRaw(t *testing.T, in <-chan []byte, want string) []byte {
	t.Helper()
	for range 50 {
		f := readFrame(t, in)
		if f.env.Type == want {
			return f.raw
		}
	}
	t.Fatalf("no %s frame arrived", want)
	return nil
}
