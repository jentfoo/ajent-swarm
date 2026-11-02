package fleet

import (
	"context"
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

// newTestFleet points AJENT_HOME at a temp dir and starts a fast manager.
// The home stays short: unix socket paths cap at ~108 bytes, and t.TempDir
// names grow with the test name.
func newTestFleet(t *testing.T, owned func(inst ctl.Instance) bool) (*Manager, string) {
	t.Helper()
	home, err := os.MkdirTemp("", "fleet")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv(paths.EnvHome, home)
	m := New(Options{
		Log:          testLogger(),
		PollInterval: testPoll,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		Owned:        owned,
	})
	m.Start(context.Background())
	t.Cleanup(m.Stop)
	return m, home
}

// subscribeTest registers one test viewer; frames flow into the channel.
func subscribeTest(t *testing.T, m *Manager, sessionID string) (*Subscription, <-chan []byte) {
	t.Helper()
	out := make(chan []byte, 256)
	var sub *Subscription
	require.Eventually(t, func() bool { // discovery may not have run yet
		s, err := m.Subscribe(sessionID, func(b []byte) { out <- b }, nil)
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

// readFrame pulls one frame; a stall fails through the timeout.
func readFrame(t *testing.T, in <-chan []byte) frame {
	t.Helper()
	select {
	case b := <-in:
		var f wire
		require.NoError(t, json.Unmarshal(b, &f))
		return frame{raw: b, env: f}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a frame")
		return frame{}
	}
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

func TestManagerAttachesAndServesInit(t *testing.T) {
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
}

func TestManagerSeatPolicy(t *testing.T) {
	t.Run("owned force claims seat", func(t *testing.T) {
		m, home := newTestFleet(t, func(inst ctl.Instance) bool { return inst.SessionID == "01OWNED00000000000" })
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01OWNED00000000000"})
		f.WriteRegistry(t, os.Getpid(), time.Now())

		waitForState(t, m, f.SessionID(), ChildOnline)
		assert.Equal(t, holderName, f.SeatHolder())
	})

	t.Run("external sessions stay observers", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01EXTERNAL00000000"})
		f.WriteRegistry(t, os.Getpid(), time.Now())

		waitForState(t, m, f.SessionID(), ChildOnline)
		assert.Empty(t, f.SeatHolder()) // a human --attach is never displaced
	})
}

func TestTakeControlForceClaimsOnce(t *testing.T) {
	m, home := newTestFleet(t, nil)
	f := fleettest.New(t, home, fleettest.Options{SessionID: "01TAKECTRL00000000"})
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)

	require.NoError(t, m.TakeControl(context.Background(), f.SessionID()))
	assert.Equal(t, holderName, f.SeatHolder())

	// seat policy never re-forces on its own: a displaced holder keeps the
	// seat until an explicit command takes it back
	f.Broadcast(ctl.EventNotice, ctl.NoticeData{Text: "n"})
	require.NoError(t, m.TakeControl(context.Background(), f.SessionID()))
	assert.Equal(t, holderName, f.SeatHolder())
}

func TestTakeControlSurfacesSeatHeld(t *testing.T) {
	m, home := newTestFleet(t, nil)
	f := fleettest.New(t, home, fleettest.Options{SessionID: "01REFUSED000000000", Refuses: true})
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)

	err := m.TakeControl(context.Background(), f.SessionID())
	require.Error(t, err)
	var wire *ctl.Error
	require.ErrorAs(t, err, &wire)
	assert.Equal(t, ctl.CodeSeatHeld, wire.Code) // the UI renders the holder from this
}

func TestExitEndsTrackingCleanly(t *testing.T) {
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
		250*time.Millisecond, testPoll)
}

func TestReconnectResnapshotsWithoutDuplicates(t *testing.T) {
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
	page, _, err := m.Entries(context.Background(), f.SessionID(), "", 100)
	require.NoError(t, err)
	assert.Len(t, page, 2) // backfill plus overlapping live appends dedupe by id
}

func TestFollowsARestartedInstance(t *testing.T) {
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
}

func TestManagerNeverDialsDeadRecord(t *testing.T) {
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
		150*time.Millisecond, testPoll)
}

func TestUnknownSessionSubscribeFailsFast(t *testing.T) {
	m, _ := newTestFleet(t, nil)
	_, err := m.Subscribe("01NOBODY00000000000", func([]byte) {}, nil)
	require.ErrorIs(t, err, ErrUnknownSession)
}

func TestTwoViewersSeeIdenticalState(t *testing.T) {
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
}

// expectRaw returns the raw bytes of the next frame of the wanted type.
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
