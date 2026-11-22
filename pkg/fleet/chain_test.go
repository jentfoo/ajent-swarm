package fleet

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
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

// chainWindow and chainTickEvery tune chain fleets for tests.
const (
	chainWindow    = 50 * time.Millisecond
	chainTickEvery = 20 * time.Millisecond
)

// newChainFleet starts a fast manager plus one serving stub named parent,
// whose transcript is written before the fleet attaches so the backfill
// carries it.
func newChainFleet(t *testing.T, transcript ...session.Entry) (*Manager, *fleettest.Stub) {
	t.Helper()
	home := testutil.IsolateHome(t)
	m := New(Options{
		Log:            testLogger(),
		PollInterval:   testPoll,
		BackoffBase:    testBackoff,
		BackoffMax:     testBackoffHi,
		ParkIdleWindow: chainWindow,
		ChainPoll:      chainTickEvery,
	})
	m.Start(t.Context())
	t.Cleanup(m.Stop)
	f := fleettest.New(t, home, fleettest.Options{SessionID: "01PARENTSESSION00000A"})
	f.SetSnapshot(ctl.State{Session: ctl.Session{ID: f.SessionID()}})
	if len(transcript) > 0 {
		f.WriteTranscript(t, transcript...)
	}
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)
	// every parent stub enters with a completed prior turn, so a bare chain
	// starts from a real review point rather than an unexplained idle row
	f.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
	return m, f
}

// chainStub binds a second serving stub beside an existing fleet, sharing
// the fleet's isolated home. The transcript writes before the registry does,
// so the fleet's attach backfill carries it.
func chainStub(t *testing.T, m *Manager, sessionID string, transcript ...session.Entry) *fleettest.Stub {
	t.Helper()
	f := fleettest.New(t, os.Getenv(paths.EnvHome), fleettest.Options{SessionID: sessionID})
	f.SetSnapshot(ctl.State{Session: ctl.Session{ID: f.SessionID()}})
	if len(transcript) > 0 {
		f.WriteTranscript(t, transcript...)
	}
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)
	return f
}

// assistantEntry builds one assistant message entry for transcripts.
func assistantEntry(t *testing.T, id, parent, text string) session.Entry {
	t.Helper()
	return mustEntry(t, id, parent, session.TypeMessage,
		session.MessageData{Message: llm.Text(llm.RoleAssistant, text)})
}

// chainStateOf reads one chain's state from the registry snapshot.
func chainStateOf(t *testing.T, m *Manager, id string) string {
	t.Helper()
	for _, ch := range m.ChainList() {
		if ch.ID == id {
			return ch.State
		}
	}
	return ""
}

// waitChainState blocks until one chain reaches the wanted state.
func waitChainState(t *testing.T, m *Manager, id, state string) Chain {
	t.Helper()
	require.Eventually(t, func() bool { return chainStateOf(t, m, id) == state },
		3*time.Second, testPoll)
	for _, ch := range m.ChainList() {
		if ch.ID == id {
			return ch
		}
	}
	return Chain{}
}

// childSubmits reads every line the child stub received through submit.
func childSubmits(f *fleettest.Stub) []string {
	var lines []string
	for _, req := range f.Received() {
		if req.Method != ctl.MethodSubmit {
			continue
		}
		var p ctl.SubmitParams
		if json.Unmarshal(req.Params, &p) == nil && p.Line != "" {
			lines = append(lines, p.Line)
		}
	}
	return lines
}

func TestChainLine(t *testing.T) {
	t.Parallel()
	t.Run("wraps_tail_and_prompt", func(t *testing.T) {
		line := chainLine(strings.Repeat("x", 9000), "continue")
		require.True(t, strings.HasPrefix(line, chainLineHeader+"\n"))
		require.True(t, strings.HasSuffix(line, chainLineSep+"continue"))
		// the tail keeps its end: 8000 of the original runes survive
		body := line[len(chainLineHeader)+1 : strings.Index(line, chainLineSep)]
		assert.Len(t, []rune(body), maxComposedRunes)
		assert.True(t, strings.HasSuffix(body, "x"))
	})
}

func TestChainHeld(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		st   Status
		want bool
	}{
		{name: "idle"},
		{name: "dialog", st: Status{digestFacts: digestFacts{OpenInteractions: 1}}, want: true},
		{name: "running", st: Status{digestFacts: digestFacts{Running: true}}, want: true},
		{name: "spinning", st: Status{digestFacts: digestFacts{Spinning: true}}, want: true},
		{name: "queued", st: Status{Queued: 1}, want: true},
		{name: "parked", st: Status{digestFacts: digestFacts{Parked: 1}}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, chainHeld(&tc.st))
		})
	}
}

func TestChainCollectResponseRequiresMark(t *testing.T) {
	m, parent := newChainFleet(t,
		prompt(t, "01U1", "", "first question"),
		assistantEntry(t, "01A1", "01U1", "old answer"))

	// an absent mark never owns the newest answer, whatever the transcript
	// holds above the retained window
	_, ok := m.collectResponse(t.Context(), parent.SessionID(), "01MISSING")
	assert.False(t, ok)
}

func TestCreateChain(t *testing.T) {
	t.Run("refuses_unknown_and_same_sessions", func(t *testing.T) {
		m, parent := newChainFleet(t)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		_, err := m.CreateChain(t.Context(), parent.SessionID(), "01MISSING000000000",
			ChainParams{ChildPrompt: "go"})
		require.ErrorIs(t, err, ErrUnknownSession)

		_, err = m.CreateChain(t.Context(), parent.SessionID(), parent.SessionID(),
			ChainParams{ChildPrompt: "go"})
		require.ErrorIs(t, err, ErrChainInvalid)

		_, err = m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{})
		require.ErrorIs(t, err, ErrChainInvalid)
	})

	t.Run("refuses_conflict_and_cycle", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil) // hold every chain in waiting
		waitForRunning(t, m, parent, true)
		mid := chainStub(t, m, "01CHILDSESSION00000B")
		other := chainStub(t, m, "01THIRDSESSION000000C")

		first, err := m.CreateChain(t.Context(), parent.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "go"})
		require.NoError(t, err)

		_, err = m.CreateChain(t.Context(), other.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "again"})
		require.ErrorIs(t, err, ErrChainConflict)

		_, err = m.CreateChain(t.Context(), mid.SessionID(), parent.SessionID(),
			ChainParams{ChildPrompt: "loop"})
		require.ErrorIs(t, err, ErrChainCycle)

		require.NoError(t, m.CancelChain(t.Context(), first.ID))
		// a canceled chain frees the child for a fresh link
		_, err = m.CreateChain(t.Context(), other.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "again"})
		assert.NoError(t, err)
	})

	t.Run("enforces_the_cap", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		m.mu.Lock()
		for i := range maxChains {
			m.chains[strings.Repeat("0", 7)+string(rune('a'+i))] = &chainRun{ch: Chain{
				ID:       strings.Repeat("0", 7) + string(rune('a'+i)),
				ParentID: parent.SessionID(),
				ChildID:  strings.Repeat("1", 8),
				State:    ChainWaiting,
			}}
		}
		m.mu.Unlock()

		child := chainStub(t, m, "01CHILDSESSION00000B")
		_, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "go"})
		assert.ErrorIs(t, err, ErrTooManyChains)
	})
}

// TestChainQueuedChildNaming covers the create-time labeler kick: a queued
// child names from its start prompt at once, a stored title stands instead.
func TestChainQueuedChildNaming(t *testing.T) {
	t.Run("names_from_start_prompt", func(t *testing.T) {
		store := newTitleMemStore()
		bin, runs := fakeNamerBin(t)
		home := testutil.IsolateHome(t)
		m := New(Options{
			Log:            testLogger(),
			PollInterval:   testPoll,
			BackoffBase:    testBackoff,
			BackoffMax:     testBackoffHi,
			AjentBin:       bin,
			TitleStore:     store,
			ParkIdleWindow: chainWindow,
			ChainPoll:      chainTickEvery,
		})
		m.Start(t.Context())
		t.Cleanup(m.Stop)

		parent := fleettest.New(t, home, fleettest.Options{SessionID: "01PARENTSESSION00000A"})
		parent.SetSnapshot(ctl.State{Session: ctl.Session{ID: parent.SessionID()}})
		parent.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, parent.SessionID(), ChildOnline)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		_, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "fix the login flow"})
		require.NoError(t, err)

		// the labeler queries the start prompt at create, not at handoff
		require.Eventually(t, func() bool {
			return store.snapshot()[child.SessionID()] == "Fix login flow"
		}, 2*time.Second, testPoll)
		assert.Equal(t, 1, runs())
	})

	t.Run("stored_title_skips_namer", func(t *testing.T) {
		store := newTitleMemStore()
		bin, runs := fakeNamerBin(t)
		home := testutil.IsolateHome(t)
		m := New(Options{
			Log:            testLogger(),
			PollInterval:   testPoll,
			BackoffBase:    testBackoff,
			BackoffMax:     testBackoffHi,
			AjentBin:       bin,
			TitleStore:     store,
			ParkIdleWindow: chainWindow,
			ChainPoll:      chainTickEvery,
		})
		m.Start(t.Context())
		t.Cleanup(m.Stop)

		parent := fleettest.New(t, home, fleettest.Options{SessionID: "01PARENTSESSION00000A"})
		parent.SetSnapshot(ctl.State{Session: ctl.Session{ID: parent.SessionID()}})
		parent.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, parent.SessionID(), ChildOnline)
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		child := chainStub(t, m, "01CHILDSESSION00000B")
		require.NoError(t, m.SetTitle(t.Context(), child.SessionID(), "hand picked"))

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "fix the login flow"})
		require.NoError(t, err)
		waitChainState(t, m, ch.ID, ChainDone)

		// the typed name stands, the labeler never runs for the child
		assert.Equal(t, 0, runs())
		assert.Equal(t, "hand picked", store.snapshot()[child.SessionID()])
	})
}

func TestChainPump(t *testing.T) {
	t.Run("bare_prompt_without_final", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		child := chainStub(t, m, "01CHILDSESSION00000B")

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue from here", PendingID: "pd1"})
		require.NoError(t, err)
		waitChainState(t, m, ch.ID, ChainDone)

		// no final prompt: the child gets its prompt alone, the parent's latest
		// response never rides along
		lines := childSubmits(child)
		require.Len(t, lines, 1)
		assert.Equal(t, "continue from here", lines[0])
	})

	t.Run("final_prompt_hands_off_its_response", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "old answer"))
		child := chainStub(t, m, "01CHILDSESSION00000B")

		// the stub answers the final prompt like a served turn would: the
		// submitted line commits under its pending id, a fresh response follows,
		// the turn ends
		parent.OnSubmit(func(p ctl.SubmitParams) {
			parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01U2", ParentID: "01A1", Type: string(session.TypeMessage),
				TS: 101, Data: mustJSON(session.MessageData{
					Message:  llm.Text(llm.RoleUser, p.Line),
					QueueIDs: []string{p.PendingID}}),
			}})
			parent.Broadcast(ctl.EventTurnStart, nil)
			parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01A2", ParentID: "01U2", Type: string(session.TypeMessage),
				TS: 102, Data: mustJSON(session.MessageData{
					Message: llm.Text(llm.RoleAssistant, "fresh answer")}),
			}})
			parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		})

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue"})
		require.NoError(t, err)
		waitChainState(t, m, ch.ID, ChainDone)

		// the final prompt ran on the parent, the fresh response rode the line
		var finalSeen bool
		for _, req := range parent.Received() {
			if req.Method == ctl.MethodSubmit {
				finalSeen = true
			}
		}
		assert.True(t, finalSeen)
		lines := childSubmits(child)
		require.Len(t, lines, 1)
		assert.Contains(t, lines[0], "fresh answer")
		assert.NotContains(t, lines[0], "old answer")
	})

	t.Run("waits_out_the_parent_turn", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		require.Never(t, func() bool { return len(childSubmits(child)) > 0 },
			3*chainWindow, chainTickEvery)
		assert.Equal(t, ChainWaiting, chainStateOf(t, m, ch.ID))

		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		waitChainState(t, m, ch.ID, ChainDone)
		require.Len(t, childSubmits(child), 1)
	})

	t.Run("sequence_waits_for_the_inbound_handoff", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		// the mid session answers its handoff like a served turn would, so the
		// second link has a fresh response to collect once it may run
		mid := chainStub(t, m, "01CHILDSESSION00000B")
		mid.OnSubmit(func(p ctl.SubmitParams) {
			mid.Broadcast(ctl.EventTurnStart, nil)
			mid.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01M2", Type: string(session.TypeMessage),
				TS: 201, Data: mustJSON(session.MessageData{
					Message: llm.Text(llm.RoleUser, p.Line)}),
			}})
			mid.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01M3", ParentID: "01M2", Type: string(session.TypeMessage),
				TS: 202, Data: mustJSON(session.MessageData{
					Message: llm.Text(llm.RoleAssistant, "mid answer")}),
			}})
			mid.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		})
		third := chainStub(t, m, "01THIRDSESSION000000C")

		parent.Broadcast(ctl.EventTurnStart, nil) // hold the first link in waiting
		waitForRunning(t, m, parent, true)

		first, err := m.CreateChain(t.Context(), parent.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		second, err := m.CreateChain(t.Context(), mid.SessionID(), third.SessionID(),
			ChainParams{ChildPrompt: "pick it up"})
		require.NoError(t, err)

		// the mid session is idle and quiet, but the inbound link holds the
		// sequence: the second chain neither hands off nor fails early
		require.Never(t, func() bool { return chainStateOf(t, m, second.ID) != ChainWaiting },
			3*chainWindow, chainTickEvery)

		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		waitChainState(t, m, first.ID, ChainDone)
		waitChainState(t, m, second.ID, ChainDone)

		// both lines landed in order: the mid session received the parent's
		// chain, the third session the mid session's handoff — bare prompts,
		// since neither link asked for a final prompt
		midLines := childSubmits(mid)
		require.Len(t, midLines, 1)
		assert.Equal(t, "continue", midLines[0])
		lines := childSubmits(third)
		require.Len(t, lines, 1)
		assert.Equal(t, "pick it up", lines[0])
	})

	t.Run("waits_out_queued_prompts", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		// a second prompt sits queued behind the running turn, so the session
		// still owes work even between its turns
		parent.Broadcast(ctl.EventQueued, ctl.QueuedData{
			Rows: []ctl.QueueRow{{ID: "q1", Text: "next thing"}},
		})
		require.Eventually(t, func() bool {
			for _, s := range m.Sessions() {
				if s.SessionID == parent.SessionID() {
					return s.Queued == 1
				}
			}
			return false
		}, 2*time.Second, testPoll)

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)

		// the running turn ends but the queued prompt still owes its turn: the
		// chain must hold, firing here interleaves the handoff with owed work
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		waitForRunning(t, m, parent, false)
		require.Never(t, func() bool { return len(childSubmits(child)) > 0 },
			5*chainWindow, chainTickEvery)

		// the queue drains, the parent finally sits in review
		parent.Broadcast(ctl.EventQueued, ctl.QueuedData{})
		waitChainState(t, m, ch.ID, ChainDone)
		require.Len(t, childSubmits(child), 1)
	})

	t.Run("canceled_before_delivery_never_submits", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		require.NoError(t, m.CancelChain(t.Context(), ch.ID))
		assert.Equal(t, ChainCanceled, chainStateOf(t, m, ch.ID))

		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		require.Never(t, func() bool { return len(childSubmits(child)) > 0 },
			5*chainWindow, chainTickEvery)
	})

	t.Run("fails_when_the_final_turn_made_no_text", func(t *testing.T) {
		m, parent := newChainFleet(t)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		// the final prompt lands and its turn ends without any assistant text
		parent.OnSubmit(func(p ctl.SubmitParams) {
			parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01U2", Type: string(session.TypeMessage),
				TS: 101, Data: mustJSON(session.MessageData{
					Message:  llm.Text(llm.RoleUser, p.Line),
					QueueIDs: []string{p.PendingID}}),
			}})
			parent.Broadcast(ctl.EventTurnStart, nil)
			parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		})

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue"})
		require.NoError(t, err)
		failed := waitChainState(t, m, ch.ID, ChainFailed)
		assert.Equal(t, "nothing to hand off", failed.Reason)
		assert.Empty(t, childSubmits(child))
	})

	t.Run("child_exit_fails_the_chain", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		child.Exit("done")
		waitForState(t, m, child.SessionID(), ChildExited)

		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		failed := waitChainState(t, m, ch.ID, ChainFailed)
		assert.Equal(t, "child exited", failed.Reason)
	})

	t.Run("update_reruns_waiting_and_refuses_late", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		child := chainStub(t, m, "01CHILDSESSION00000B")

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		edited, err := m.UpdateChain(t.Context(), ch.ID,
			ChainParams{ChildPrompt: "edited prompt"})
		require.NoError(t, err)
		assert.Equal(t, ChainWaiting, edited.State)

		waitChainState(t, m, ch.ID, ChainDone)
		lines := childSubmits(child)
		require.Len(t, lines, 1)
		assert.Equal(t, "edited prompt", lines[0])

		_, err = m.UpdateChain(t.Context(), ch.ID, ChainParams{ChildPrompt: "late"})
		assert.ErrorIs(t, err, ErrChainEditing)
	})

	t.Run("bare_prompt_waits_for_a_review_point", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl")
		m := startChainFleetAt(t, chainFleetConfig{store: newMemChainStore()}, home)
		waitForState(t, m, parent.SessionID(), ChildOnline)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		require.Never(t, func() bool { return chainStateOf(t, m, ch.ID) != ChainWaiting },
			3*chainWindow, chainTickEvery)
		assert.Empty(t, childSubmits(child))

		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		waitChainState(t, m, ch.ID, ChainDone)
		require.Len(t, childSubmits(child), 1)
	})

	t.Run("final_prompt_waits_for_its_own_review", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "old answer"))
		child := chainStub(t, m, "01CHILDSESSION00000B")

		release := make(chan struct{})
		parent.OnSubmit(func(p ctl.SubmitParams) {
			parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01U2", ParentID: "01A1", Type: string(session.TypeMessage),
				TS: 101, Data: mustJSON(session.MessageData{
					Message: llm.Text(llm.RoleUser, p.Line), QueueIDs: []string{p.PendingID}}),
			}})
			<-release
			parent.Broadcast(ctl.EventTurnStart, nil)
			parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01A2", ParentID: "01U2", Type: string(session.TypeMessage),
				TS: 102, Data: mustJSON(session.MessageData{
					Message: llm.Text(llm.RoleAssistant, "fresh answer")}),
			}})
			parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		})

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue"})
		require.NoError(t, err)
		waitChainState(t, m, ch.ID, ChainFinal)

		// the mark landed, but the prior review predates the final submit: the
		// child holds until this turn reaches its own review point
		require.Never(t, func() bool { return len(childSubmits(child)) > 0 },
			3*chainWindow, chainTickEvery)
		close(release)
		waitChainState(t, m, ch.ID, ChainDone)
		require.Len(t, childSubmits(child), 1)
		assert.Contains(t, childSubmits(child)[0], "fresh answer")
	})
}

// TestChainSequence pins the ordering contract across stacked links: a link
// fires only after the link behind it delivered, and a link that dies without
// delivering breaks the tail instead of letting it read the shared session as
// idle and fire early.
func TestChainSequence(t *testing.T) {
	t.Run("upstream_child_exit_breaks_the_tail", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil) // the root is still working
		waitForRunning(t, m, parent, true)
		mid := chainStub(t, m, "01CHILDSESSION00000B")
		third := chainStub(t, m, "01THIRDSESSION000000C")

		first, err := m.CreateChain(t.Context(), parent.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		second, err := m.CreateChain(t.Context(), mid.SessionID(), third.SessionID(),
			ChainParams{ChildPrompt: "pick it up"})
		require.NoError(t, err)

		// the root's turn ends, the first link moves to deliver, then the mid
		// session dies before the handoff lands
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		waitChainState(t, m, first.ID, ChainDelivering)
		mid.Exit("done")
		waitForState(t, m, mid.SessionID(), ChildExited)
		failed := waitChainState(t, m, first.ID, ChainFailed)
		assert.Equal(t, "child exited", failed.Reason)

		// the break cascades: the deep link dies with its upstream, the third
		// session never runs the queued line
		broken := waitChainState(t, m, second.ID, ChainFailed)
		assert.Equal(t, "upstream child exited", broken.Reason)
		assert.Empty(t, childSubmits(third))
	})

	t.Run("upstream_cancel_breaks_the_tail", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		mid := chainStub(t, m, "01CHILDSESSION00000B")
		third := chainStub(t, m, "01THIRDSESSION000000C")

		first, err := m.CreateChain(t.Context(), parent.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		second, err := m.CreateChain(t.Context(), mid.SessionID(), third.SessionID(),
			ChainParams{ChildPrompt: "pick it up"})
		require.NoError(t, err)

		require.NoError(t, m.CancelChain(t.Context(), first.ID))
		waitChainState(t, m, second.ID, ChainCanceled)

		// the queued line behind a canceled link never runs, the root keeps working
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		require.Never(t, func() bool { return len(childSubmits(third)) > 0 },
			5*chainWindow, chainTickEvery)
	})

	t.Run("upstream_timeout_breaks_the_tail", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		m := startChainFleetAt(t, chainFleetConfig{store: newMemChainStore(), maxAge: 600 * time.Millisecond}, home)
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl")
		waitForState(t, m, parent.SessionID(), ChildOnline)
		parent.Broadcast(ctl.EventTurnStart, nil) // the root never finishes
		waitForRunning(t, m, parent, true)
		mid := chainPersistStub(t, home, "01CHILDSESSION00000B", "mid.jsonl")
		waitForState(t, m, mid.SessionID(), ChildOnline)
		third := chainPersistStub(t, home, "01THIRDSESSION000000C", "third.jsonl")
		waitForState(t, m, third.SessionID(), ChildOnline)

		first, err := m.CreateChain(t.Context(), parent.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		second, err := m.CreateChain(t.Context(), mid.SessionID(), third.SessionID(),
			ChainParams{ChildPrompt: "pick it up"})
		require.NoError(t, err)
		// the head link ages out well before the tail's own bound, so the
		// cascade is what lands the tail, not its own clock
		m.mu.Lock()
		if run := m.chains[first.ID]; run != nil {
			run.ch.CreatedAt -= 1000
		}
		m.mu.Unlock()

		// the age bound fails the first link while the root still works, the
		// deep link must land terminal beside it instead of firing on the
		// idle mid session
		broken := waitChainState(t, m, second.ID, ChainFailed)
		assert.Equal(t, "upstream timed out", broken.Reason)
		assert.Empty(t, childSubmits(third))
	})

	t.Run("cascades_through_every_stacked_link", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil) // the root never finishes
		waitForRunning(t, m, parent, true)
		mid := chainStub(t, m, "01CHILDSESSION00000B")
		third := chainStub(t, m, "01THIRDSESSION000000C")
		fourth := chainStub(t, m, "01FOURTHSESSION00000D")

		first, err := m.CreateChain(t.Context(), parent.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		_, err = m.CreateChain(t.Context(), mid.SessionID(), third.SessionID(),
			ChainParams{ChildPrompt: "pick it up"})
		require.NoError(t, err)
		tail, err := m.CreateChain(t.Context(), third.SessionID(), fourth.SessionID(),
			ChainParams{ChildPrompt: "finish it"})
		require.NoError(t, err)

		// the head of the line breaks, the whole tail lands canceled with it
		require.NoError(t, m.CancelChain(t.Context(), first.ID))
		broken := waitChainState(t, m, tail.ID, ChainCanceled)
		assert.Equal(t, "upstream canceled", broken.Reason)
		assert.Empty(t, childSubmits(fourth))
	})
}

func TestChainDigestFold(t *testing.T) {
	m, parent := newChainFleet(t)
	parent.Broadcast(ctl.EventTurnStart, nil)
	waitForRunning(t, m, parent, true)
	child := chainStub(t, m, "01CHILDSESSION00000B")

	ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
		ChainParams{FinalPrompt: "wrap up", ChildPrompt: "continue"})
	require.NoError(t, err)

	// waiting: both endpoints badge their link, the child waits on the parent
	// and the parent names the child it will feed
	require.Eventually(t, func() bool {
		for _, row := range m.Attention() {
			if row.SessionID == child.SessionID() {
				return row.ChainedOn == parent.SessionID() && row.ChainedOnID == ch.ID
			}
		}
		return false
	}, 2*time.Second, testPoll)
	for _, row := range m.Attention() {
		if row.SessionID == child.SessionID() {
			assert.Equal(t, AttentionAwaiting, row.Kind)
			// chain facts are additive, the row's own reason stays untouched
			assert.Equal(t, "waiting for a prompt", row.Reason)
		}
		if row.SessionID == parent.SessionID() {
			assert.Equal(t, child.SessionID(), row.DeliveringTo)
			assert.Equal(t, ch.ID, row.DeliveringID)
		}
	}
	for _, st := range m.Sessions() {
		if st.SessionID == child.SessionID() {
			assert.Equal(t, ch.ID, st.ChainedOnID)
			assert.Equal(t, parent.SessionID(), st.ChainedOn)
		}
	}

	// once the final prompt runs, the parent carries the delivering fact
	parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
	require.Eventually(t, func() bool {
		for _, row := range m.Attention() {
			if row.SessionID == parent.SessionID() {
				return row.DeliveringTo == child.SessionID()
			}
		}
		return false
	}, 2*time.Second, testPoll)
}

func TestChainFoldUnit(t *testing.T) {
	t.Parallel()

	t.Run("inbound_fold_keeps_the_row_reason", func(t *testing.T) {
		t.Parallel()
		row := Attention{digestFacts: digestFacts{SessionID: "01C"}, Kind: AttentionAwaiting,
			Reason: "waiting for a prompt"}
		foldChainFacts(&row.digestFacts, chainFold{inbound: "01P", inboundID: "chn_1"})
		assert.Equal(t, "waiting for a prompt", row.Reason)
		assert.Equal(t, "01P", row.ChainedOn)
		assert.Equal(t, "chn_1", row.ChainedOnID)
	})

	t.Run("busy_row_keeps_its_kind", func(t *testing.T) {
		t.Parallel()
		row := Attention{digestFacts: digestFacts{SessionID: "01C"}, Kind: AttentionWorking,
			Reason: "compiling"}
		foldChainFacts(&row.digestFacts, chainFold{inbound: "01P", inboundID: "chn_1"})
		assert.Equal(t, AttentionWorking, row.Kind)
		assert.Equal(t, "compiling", row.Reason)
	})

	t.Run("delivering_fold_names_the_child", func(t *testing.T) {
		t.Parallel()
		row := Attention{digestFacts: digestFacts{SessionID: "01P"}, Kind: AttentionWorking}
		foldChainFacts(&row.digestFacts, chainFold{outbound: "01C", outboundID: "chn_1"})
		assert.Equal(t, "01C", row.DeliveringTo)
		assert.Equal(t, "chn_1", row.DeliveringID)
		assert.Empty(t, row.ChainedOn)
	})

	t.Run("failure_fold_carries_the_cause_on_both_roles", func(t *testing.T) {
		t.Parallel()
		child := Attention{digestFacts: digestFacts{SessionID: "01C"}, Kind: AttentionAwaiting}
		foldChainFacts(&child.digestFacts, chainFold{
			inbound: "01P", inboundID: "chn_1", failure: "child exited",
		})
		parent := Attention{digestFacts: digestFacts{SessionID: "01P"}, Kind: AttentionWorking}
		foldChainFacts(&parent.digestFacts, chainFold{
			outbound: "01C", outboundID: "chn_1", failure: "child exited",
		})
		assert.Equal(t, "child exited", child.ChainFailure)
		assert.Equal(t, "child exited", parent.ChainFailure)
		assert.Equal(t, "01C", parent.DeliveringTo)
	})

	t.Run("dual_role_folds_stack", func(t *testing.T) {
		t.Parallel()
		row := Attention{digestFacts: digestFacts{SessionID: "01M"}, Kind: AttentionAwaiting}
		foldChainFacts(&row.digestFacts, chainFold{inbound: "01A", inboundID: "chn_a"})
		foldChainFacts(&row.digestFacts, chainFold{outbound: "01Z", outboundID: "chn_z"})
		assert.Equal(t, "01A", row.ChainedOn)
		assert.Equal(t, "chn_a", row.ChainedOnID)
		assert.Equal(t, "01Z", row.DeliveringTo)
		assert.Equal(t, "chn_z", row.DeliveringID)
	})
}

// memChainStore is an in-memory ChainStore, the persistence seam restart
// tests drive.
type memChainStore struct {
	mu   sync.Mutex
	rows map[string]Chain
}

func newMemChainStore() *memChainStore {
	return &memChainStore{rows: make(map[string]Chain)}
}

func (s *memChainStore) SaveChain(_ context.Context, ch Chain) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows[ch.ID] = ch
	return nil
}

func (s *memChainStore) DeleteChain(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rows, id)
	return nil
}

func (s *memChainStore) LoadChains(_ context.Context) ([]Chain, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Chain, 0, len(s.rows))
	for _, ch := range s.rows {
		out = append(out, ch)
	}
	slices.SortFunc(out, func(a, b Chain) int { return int(a.CreatedAt - b.CreatedAt) })
	return out, nil
}

// rowOf reads one stored record, missing rows answer a zero Chain.
func (s *memChainStore) rowOf(id string) Chain {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rows[id]
}

// putRowOf forces one stored record, tests use it to replay a crash that
// dropped the last persist.
func (s *memChainStore) putRowOf(ch Chain) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows[ch.ID] = ch
}

// chainFleetConfig names the tuned fields every chain fleet shares.
type chainFleetConfig struct {
	store    *memChainStore
	maxAge   time.Duration
	grace    time.Duration
	parkIdle time.Duration
}

// startChainFleetAt starts a manager over an existing isolated home.
func startChainFleetAt(t *testing.T, cfg chainFleetConfig, home string) *Manager {
	t.Helper()
	park := cfg.parkIdle
	if park == 0 {
		park = chainWindow
	}
	m := New(Options{
		Log:            testLogger(),
		PollInterval:   testPoll,
		BackoffBase:    testBackoff,
		BackoffMax:     testBackoffHi,
		ParkIdleWindow: park,
		ChainPoll:      chainTickEvery,
		ChainStore:     cfg.store,
		ChainMaxAge:    cfg.maxAge,
		ChainGrace:     cfg.grace,
	})
	m.Start(t.Context())
	t.Cleanup(m.Stop)
	return m
}

// queuedEntry builds one user entry landed under a submit's pending id.
func queuedEntry(t *testing.T, id, parent, pendingID, text string) session.Entry {
	t.Helper()
	return mustEntry(t, id, parent, session.TypeMessage, session.MessageData{
		Message: llm.Text(llm.RoleUser, text), QueueIDs: []string{pendingID},
	})
}

// finalPromptEntry builds the user entry a landed final submit commits,
// carrying the chain's pending id for restart recovery.
func finalPromptEntry(t *testing.T, id, parent, chainID, text string) session.Entry {
	t.Helper()
	return queuedEntry(t, id, parent, chainFinalPendingID(chainID), text)
}

// chainPersistStub starts one serving stub with its own transcript file, so
// sibling stubs never truncate each other's recordings across restarts.
func chainPersistStub(t *testing.T, home, sessionID, transcript string,
	entries ...session.Entry,
) *fleettest.Stub {
	t.Helper()
	f := fleettest.New(t, home, fleettest.Options{SessionID: sessionID, Transcript: transcript})
	f.SetSnapshot(ctl.State{Session: ctl.Session{ID: f.SessionID()}})
	if len(entries) > 0 {
		f.WriteTranscript(t, entries...)
	}
	f.WriteRegistry(t, os.Getpid(), time.Now())
	return f
}

func TestChainPersistence(t *testing.T) {
	t.Run("waiting_chain_survives_restart_and_delivers", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		store := newMemChainStore()
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl",
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")
		child.SetSnapshot(ctl.State{Session: ctl.Session{ID: child.SessionID()}})
		child.WriteRegistry(t, os.Getpid(), time.Now())

		m1 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitForState(t, m1, parent.SessionID(), ChildOnline)
		waitForState(t, m1, child.SessionID(), ChildOnline)
		parent.Broadcast(ctl.EventTurnStart, nil) // hold the chain in waiting
		waitForRunning(t, m1, parent, true)

		ch, err := m1.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue", PendingID: "pd1"})
		require.NoError(t, err)
		require.Equal(t, ChainWaiting, store.rowOf(ch.ID).State)
		m1.Stop()

		m2 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitForState(t, m2, parent.SessionID(), ChildOnline)
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		waitChainState(t, m2, ch.ID, ChainDone)

		lines := childSubmits(child)
		require.Len(t, lines, 1) // the restart never repeats the delivery
		assert.Equal(t, "continue", lines[0])
		assert.Equal(t, ChainDone, store.rowOf(ch.ID).State)
	})

	t.Run("final_chain_restart_collects_by_entry_id", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		store := newMemChainStore()
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl",
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "old answer"))
		child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")

		m1 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitForState(t, m1, parent.SessionID(), ChildOnline)
		parent.OnSubmit(func(p ctl.SubmitParams) {
			// the final prompt landed, its turn is still running
			parent.Broadcast(ctl.EventTurnStart, nil)
		})

		ch, err := m1.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue", PendingID: "pd1"})
		require.NoError(t, err)
		waitChainState(t, m1, ch.ID, ChainFinal)
		m1.Stop()

		// the turn ran and ended while the service was down: the transcript
		// alone carries the final prompt's answer
		parent.WriteTranscript(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "old answer"),
			finalPromptEntry(t, "01B1", "01A1", ch.ID, "summarize"),
			assistantEntry(t, "01B2", "01B1", "fresh answer"))

		m2 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitChainState(t, m2, ch.ID, ChainDone)

		lines := childSubmits(child)
		require.Len(t, lines, 1)
		assert.Contains(t, lines[0], "fresh answer") // the post-final response, not the old one
		assert.NotContains(t, lines[0], "old answer")
	})

	t.Run("persisted_mark_resumes_the_final", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		store := newMemChainStore()
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl",
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "old answer"))
		child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")

		m1 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitForState(t, m1, parent.SessionID(), ChildOnline)
		parent.OnSubmit(func(p ctl.SubmitParams) {
			// the submit commits under its pending id, the answer follows, the
			// turn stays open so the mark binds while the pump still runs
			parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01B1", ParentID: "01A1", Type: string(session.TypeMessage),
				TS: 101, Data: mustJSON(session.MessageData{
					Message:  llm.Text(llm.RoleUser, p.Line),
					QueueIDs: []string{p.PendingID}}),
			}})
			parent.Broadcast(ctl.EventTurnStart, nil)
			parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01B2", ParentID: "01B1", Type: string(session.TypeMessage),
				TS: 102, Data: mustJSON(session.MessageData{
					Message: llm.Text(llm.RoleAssistant, "fresh answer")}),
			}})
		})

		ch, err := m1.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue", PendingID: "pd1"})
		require.NoError(t, err)
		require.Eventually(t, func() bool { return store.rowOf(ch.ID).Mark == "01B1" },
			3*time.Second, testPoll) // the bound entry persists with the state
		require.Equal(t, ChainFinal, store.rowOf(ch.ID).State)
		m1.Stop()

		// a restart resumes from the row's mark: no re-search, no re-submit
		parent.WriteTranscript(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "old answer"),
			finalPromptEntry(t, "01B1", "01A1", ch.ID, "summarize"),
			assistantEntry(t, "01B2", "01B1", "fresh answer"))
		m2 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitChainState(t, m2, ch.ID, ChainDone)

		submits := 0
		for _, req := range parent.Received() {
			if req.Method == ctl.MethodSubmit {
				submits++
			}
		}
		assert.Equal(t, 1, submits) // the final prompt never runs twice
		lines := childSubmits(child)
		require.Len(t, lines, 1)
		assert.Contains(t, lines[0], "fresh answer")
	})

	t.Run("restored_waiting_resumes_a_landed_final_submit", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		store := newMemChainStore()
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl")
		child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")

		m1 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitForState(t, m1, parent.SessionID(), ChildOnline)
		parent.OnSubmit(func(p ctl.SubmitParams) {
			parent.Broadcast(ctl.EventTurnStart, nil)
		})

		ch, err := m1.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue", PendingID: "pd1"})
		require.NoError(t, err)
		waitChainState(t, m1, ch.ID, ChainFinal)
		parent.WriteTranscript(t,
			finalPromptEntry(t, "01B1", "", ch.ID, "summarize"),
			assistantEntry(t, "01B2", "01B1", "fresh answer"))
		m1.Stop()

		// replay a crash between the accepted submit and its state persist
		row := store.rowOf(ch.ID)
		row.State = ChainWaiting
		store.putRowOf(row)

		m2 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitChainState(t, m2, ch.ID, ChainDone)

		// the landed final prompt never runs twice
		submits := 0
		for _, req := range parent.Received() {
			if req.Method == ctl.MethodSubmit {
				submits++
			}
		}
		assert.Equal(t, 1, submits)
		lines := childSubmits(child)
		require.Len(t, lines, 1)
		assert.Contains(t, lines[0], "fresh answer")
	})

	t.Run("restored_handoff_rebuilds_from_the_final_entry", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		store := newMemChainStore()
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl")
		child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")

		m1 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitForState(t, m1, parent.SessionID(), ChildOnline)
		parent.OnSubmit(func(p ctl.SubmitParams) {
			parent.Broadcast(ctl.EventTurnStart, nil)
		})

		ch, err := m1.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue", PendingID: "pd1"})
		require.NoError(t, err)
		waitChainState(t, m1, ch.ID, ChainFinal)
		parent.WriteTranscript(t,
			finalPromptEntry(t, "01B1", "", ch.ID, "summarize"),
			assistantEntry(t, "01B2", "01B1", "fresh answer"))
		m1.Stop()

		// replay the crash landing one state late: the recorded row still
		// says handoff, the rebuild rebinds to the final prompt's entry
		row := store.rowOf(ch.ID)
		row.State = ChainHandoff
		store.putRowOf(row)

		m2 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitChainState(t, m2, ch.ID, ChainDone)

		lines := childSubmits(child)
		require.Len(t, lines, 1)
		assert.Contains(t, lines[0], "fresh answer")
	})

	t.Run("restored_delivering_closes_done_when_the_child_holds_the_line", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		store := newMemChainStore()
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl",
			assistantEntry(t, "01A1", "", "recorded answer"))
		child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")

		m1 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitForState(t, m1, parent.SessionID(), ChildOnline)
		waitForState(t, m1, child.SessionID(), ChildOnline)
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		ch, err := m1.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue", PendingID: "pd1"})
		require.NoError(t, err)
		waitChainState(t, m1, ch.ID, ChainDone)
		require.Len(t, childSubmits(child), 1)
		// the child's transcript now carries the delivered line under pd1
		child.WriteTranscript(t, queuedEntry(t, "01UC", "", "pd1", "delivered line"))
		m1.Stop()

		// replay a crash between the accepted delivery and its state persist
		row := store.rowOf(ch.ID)
		row.State = ChainDelivering
		store.putRowOf(row)

		m2 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 250 * time.Millisecond}, home)
		waitChainState(t, m2, ch.ID, ChainDone)

		assert.Len(t, childSubmits(child), 1) // the landed line never repeats
	})
}

func TestChainPolicies(t *testing.T) {
	t.Run("tool_barrier_holds_the_handoff", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "old answer"))
		child := chainStub(t, m, "01CHILDSESSION00000B")

		// the final prompt's turn pauses unfinished behind an open tool
		// barrier: the turn ends, the dialog stays open on its human
		parent.OnSubmit(func(p ctl.SubmitParams) {
			parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID: "01U2", ParentID: "01A1", Type: string(session.TypeMessage), TS: 101,
				Data: mustJSON(session.MessageData{
					Message:  llm.Text(llm.RoleUser, p.Line),
					QueueIDs: []string{p.PendingID}}),
			}})
			parent.Broadcast(ctl.EventTurnStart, nil)
			parent.Broadcast(ctl.EventInteractionPending, ctl.InteractionPendingData{
				ID: 5, Kind: "confirm", Prompt: "allow the write?"})
			parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "tool_use"})
		})

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{FinalPrompt: "wrap up", ChildPrompt: "continue"})
		require.NoError(t, err)
		waitChainState(t, m, ch.ID, ChainFinal)

		// the paused turn's open barrier is active: the child never starts
		// while the parent waits on its human, the age bound is the backstop
		require.Never(t, func() bool { return len(childSubmits(child)) > 0 },
			10*chainWindow, chainTickEvery)

		// the barrier settles, the turn completes with its own response
		parent.Broadcast(ctl.EventInteractionSettled, ctl.InteractionSettledData{ID: 5, Kind: "confirm"})
		parent.Broadcast(ctl.EventTurnStart, nil)
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: "01A2", ParentID: "01U2", Type: string(session.TypeMessage), TS: 102,
			Data: mustJSON(session.MessageData{
				Message: llm.Text(llm.RoleAssistant, "after the barrier")}),
		}})
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})

		waitChainState(t, m, ch.ID, ChainDone)
		lines := childSubmits(child)
		require.Len(t, lines, 1)
		assert.Contains(t, lines[0], "after the barrier")
		assert.NotContains(t, lines[0], "old answer")
	})

	t.Run("age_bound_fails_a_stalled_chain", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl",
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")
		m := startChainFleetAt(t, chainFleetConfig{
			store: newMemChainStore(), maxAge: 150 * time.Millisecond,
		}, home)
		waitForState(t, m, parent.SessionID(), ChildOnline)
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})

		// a held seat refuses every delivery attempt, the chain outlives the
		// retry window but not the age bound
		child.Refuse(ctl.MethodSubmit, ctl.CodeSeatHeld, "seat held by a human")
		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)

		// the refusal retries within the quiet gate, never fails on its own
		require.Never(t, func() bool { return chainStateOf(t, m, ch.ID) == ChainFailed },
			2*chainWindow, chainTickEvery)
		require.Eventually(t, func() bool {
			submits := 0
			for _, req := range child.Received() {
				if req.Method == ctl.MethodSubmit {
					submits++
				}
			}
			return submits >= 2
		}, time.Second, chainTickEvery)

		failed := waitChainState(t, m, ch.ID, ChainFailed)
		assert.Equal(t, "timed out", failed.Reason)
	})

	t.Run("missing_child_fails_after_the_adoption_grace", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		store := newMemChainStore()
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl",
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")

		m1 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 150 * time.Millisecond}, home)
		waitForState(t, m1, parent.SessionID(), ChildOnline)
		waitForState(t, m1, child.SessionID(), ChildOnline)
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m1, parent, true)
		ch, err := m1.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		m1.Stop()

		// the child never comes back after the restart
		child.RemoveRegistry()
		m2 := startChainFleetAt(t, chainFleetConfig{store: store, grace: 150 * time.Millisecond}, home)
		waitForState(t, m2, parent.SessionID(), ChildOnline)
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})

		// the grace window holds the failure first, an exit reads after it
		require.Never(t, func() bool { return chainStateOf(t, m2, ch.ID) == ChainFailed },
			50*time.Millisecond, chainTickEvery)
		failed := waitChainState(t, m2, ch.ID, ChainFailed)
		assert.Equal(t, "child exited", failed.Reason)
	})

	t.Run("broken_upstream_row_fails_the_tail_on_restore", func(t *testing.T) {
		home := testutil.IsolateHome(t)
		store := newMemChainStore()
		parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl")
		mid := chainPersistStub(t, home, "01CHILDSESSION00000B", "mid.jsonl")
		third := chainPersistStub(t, home, "01THIRDSESSION000000C", "third.jsonl")

		// replay a crash between the two row persists: the upstream link's
		// failure row landed, the cascade's tail row never did
		now := time.Now().UnixMilli()
		store.putRowOf(Chain{ID: "chn_dead0001", ParentID: parent.SessionID(),
			ChildID: mid.SessionID(), ChildPrompt: "continue", PendingID: "pd1",
			State: ChainFailed, Reason: "timed out", CreatedAt: now - 5000, UpdatedAt: now - 10})
		store.putRowOf(Chain{ID: "chn_tail0002", ParentID: mid.SessionID(),
			ChildID: third.SessionID(), ChildPrompt: "pick it up", PendingID: "pd2",
			State: ChainWaiting, CreatedAt: now - 4000, UpdatedAt: now - 10})

		m := startChainFleetAt(t, chainFleetConfig{store: store, grace: time.Hour}, home)
		waitForState(t, m, parent.SessionID(), ChildOnline)
		waitForState(t, m, mid.SessionID(), ChildOnline)
		waitForState(t, m, third.SessionID(), ChildOnline)

		// the tail reconciles against the broken upstream row instead of
		// re-arming and firing on the idle mid session
		broken := waitChainState(t, m, "chn_tail0002", ChainFailed)
		assert.Equal(t, "upstream timed out", broken.Reason)
		assert.Equal(t, ChainFailed, store.rowOf("chn_tail0002").State)
		require.Never(t, func() bool { return len(childSubmits(third)) > 0 },
			5*chainWindow, chainTickEvery)
	})
}

// submitParams reads every submit request a stub served with full params.
func submitParams(f *fleettest.Stub) []ctl.SubmitParams {
	var out []ctl.SubmitParams
	for _, req := range f.Received() {
		if req.Method != ctl.MethodSubmit {
			continue
		}
		var p ctl.SubmitParams
		if json.Unmarshal(req.Params, &p) == nil {
			out = append(out, p)
		}
	}
	return out
}

// writeSavedSession records one transcript through ajent's own session store
// under the isolated home, so savedKnown and SavedEntries find it.
func writeSavedSession(t *testing.T, sessionID string, entries ...session.Entry) {
	t.Helper()
	store, err := session.NewStore()
	require.NoError(t, err)
	dir, err := store.Dir(t.TempDir())
	require.NoError(t, err)
	var buf []byte
	// the header predates every entry so the recorded tip resolves to the
	// transcript's newest leaf, not the header itself
	hdr := session.Entry{ID: sessionID, Type: session.TypeSession,
		TS: 1, Data: mustJSON(session.SessionData{Version: session.Version()})}
	for _, e := range append([]session.Entry{hdr}, entries...) {
		line, err := json.Marshal(e)
		require.NoError(t, err)
		buf = append(buf, line...)
		buf = append(buf, '\n')
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, "saved.jsonl"), buf, 0o600))
}

func TestChainStopWithRestoredPump(t *testing.T) {
	// production starts the fleet on a context nothing ever cancels, so a
	// restored chain pump must ride the manager context and wind down on Stop
	home := testutil.IsolateHome(t)
	store := newMemChainStore()
	parent := chainPersistStub(t, home, "01PARENTSESSION00000A", "parent.jsonl",
		prompt(t, "01U1", "", "first question"))
	child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")

	mk := func() *Manager {
		return New(Options{
			Log: testLogger(), PollInterval: testPoll, BackoffBase: testBackoff,
			BackoffMax: testBackoffHi, ParkIdleWindow: chainWindow,
			ChainPoll: chainTickEvery, ChainStore: store, ChainGrace: time.Hour,
		})
	}
	m1 := mk()
	m1.Start(t.Context())
	waitForState(t, m1, parent.SessionID(), ChildOnline)
	waitForState(t, m1, child.SessionID(), ChildOnline)
	parent.Broadcast(ctl.EventTurnStart, nil) // hold the chain in waiting
	waitForRunning(t, m1, parent, true)
	_, err := m1.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
		ChainParams{ChildPrompt: "continue"})
	require.NoError(t, err)
	m1.Stop()

	// the parent stays mid-turn across the restart, so the restored pump ticks
	parent.SetSnapshot(ctl.State{
		Session: ctl.Session{ID: parent.SessionID()}, Running: true})
	m2 := mk()
	m2.Start(context.Background()) // like pkg/app: never canceled
	waitForState(t, m2, parent.SessionID(), ChildOnline)

	stopped := make(chan struct{})
	go func() {
		m2.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("Stop hung: the restored chain pump outlives the manager")
	}
}

func TestChainFinalPromptGate(t *testing.T) {
	m, parent := newChainFleet(t,
		prompt(t, "01U1", "", "first question"),
		assistantEntry(t, "01A1", "01U1", "recorded answer"))
	parent.Broadcast(ctl.EventTurnStart, nil)
	waitForRunning(t, m, parent, true)
	child := chainStub(t, m, "01CHILDSESSION00000B")

	// a held parent holds the final prompt itself, not just the handoff
	ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
		ChainParams{FinalPrompt: "wrap up", ChildPrompt: "continue"})
	require.NoError(t, err)
	require.Never(t, func() bool { return len(submitParams(parent)) > 0 },
		3*chainWindow, chainTickEvery)
	assert.Equal(t, ChainWaiting, chainStateOf(t, m, ch.ID))

	parent.OnSubmit(func(p ctl.SubmitParams) {
		parent.Broadcast(ctl.EventTurnStart, nil)
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: "01U2", ParentID: "01A1", Type: string(session.TypeMessage), TS: 101,
			Data: mustJSON(session.MessageData{
				Message: llm.Text(llm.RoleUser, p.Line), QueueIDs: []string{p.PendingID}}),
		}})
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: "01A2", ParentID: "01U2", Type: string(session.TypeMessage), TS: 102,
			Data: mustJSON(session.MessageData{
				Message: llm.Text(llm.RoleAssistant, "fresh answer")}),
		}})
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
	})
	parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
	waitChainState(t, m, ch.ID, ChainDone)

	// the wire carried the restart-recovery pending ids on both submits
	parentSubmits := submitParams(parent)
	require.Len(t, parentSubmits, 1)
	assert.Equal(t, "wrap up", parentSubmits[0].Line)
	assert.Equal(t, chainFinalPendingID(ch.ID), parentSubmits[0].PendingID)
	childSubmits := submitParams(child)
	require.Len(t, childSubmits, 1)
	assert.Contains(t, childSubmits[0].Line, "fresh answer")
}

func TestChainDeliveringGates(t *testing.T) {
	t.Run("sibling_activity_never_holds_the_delivery", func(t *testing.T) {
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "recorded answer"))
		child := chainStub(t, m, "01CHILDSESSION00000B")
		// a sibling mid-turn shares the parent's provider, but chains gate on
		// their own endpoints only: the delivery proceeds while the sibling
		// keeps working, unlike the park queue's provider-wide gate
		sibling := chainStub(t, m, "01SIBLINGSESSION00000C")
		sibling.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, sibling, true)

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue", PendingID: "pd1"})
		require.NoError(t, err)
		waitChainState(t, m, ch.ID, ChainDone)
		params := submitParams(child)
		require.Len(t, params, 1)
		assert.Equal(t, "pd1", params[0].PendingID)
		assert.Equal(t, "continue", params[0].Line)
		assert.True(t, m.liveStatus(sibling.SessionID()).Running)
	})

	t.Run("parallel_chains_deliver_independently", func(t *testing.T) {
		// two chains sharing one provider deliver as soon as their own child
		// is free: session-based gates never serialize across chains
		m, parent := newChainFleet(t,
			prompt(t, "01U1", "", "first question"),
			assistantEntry(t, "01A1", "01U1", "answer a"))
		other := chainStub(t, m, "01SIBLINGSESSION00000C",
			prompt(t, "02U1", "", "question b"),
			assistantEntry(t, "02A1", "02U1", "answer b"))
		other.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		childA := chainStub(t, m, "01CHILDSESSION00000B")
		childB := chainStub(t, m, "01THIRDSESSION000000C")

		chA, err := m.CreateChain(t.Context(), parent.SessionID(), childA.SessionID(),
			ChainParams{ChildPrompt: "go a"})
		require.NoError(t, err)
		chB, err := m.CreateChain(t.Context(), other.SessionID(), childB.SessionID(),
			ChainParams{ChildPrompt: "go b"})
		require.NoError(t, err)
		waitChainState(t, m, chA.ID, ChainDone)
		waitChainState(t, m, chB.ID, ChainDone)
		require.Len(t, submitParams(childA), 1)
		require.Len(t, submitParams(childB), 1)
	})
}

// parentSubmitLines reads every line submitted to the parent stub in order.
func parentSubmitLines(f *fleettest.Stub) []string {
	var lines []string
	for _, req := range f.Received() {
		if req.Method != ctl.MethodSubmit {
			continue
		}
		var p ctl.SubmitParams
		if json.Unmarshal(req.Params, &p) == nil && p.Line != "" {
			lines = append(lines, p.Line)
		}
	}
	return lines
}

func TestChainSiblingSerialization(t *testing.T) {
	// two chains sharing one parent run their final prompts one turn at a
	// time, so answers never cross between them
	m, parent := newChainFleet(t)
	mid := chainStub(t, m, "01CHILDSESSION00000B")
	other := chainStub(t, m, "01THIRDSESSION000000C")

	seq := 0
	parent.OnSubmit(func(p ctl.SubmitParams) {
		seq++
		uid := fmt.Sprintf("01U%d", 10+seq)
		aid := fmt.Sprintf("01A%d", 10+seq)
		parent.Broadcast(ctl.EventTurnStart, nil)
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: uid, Type: string(session.TypeMessage),
			TS: 101, Data: mustJSON(session.MessageData{
				Message:  llm.Text(llm.RoleUser, p.Line),
				QueueIDs: []string{p.PendingID}}),
		}})
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: aid, ParentID: uid, Type: string(session.TypeMessage), TS: 102,
			Data: mustJSON(session.MessageData{
				Message: llm.Text(llm.RoleAssistant, "answer for "+p.Line)}),
		}})
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
	})

	first, err := m.CreateChain(t.Context(), parent.SessionID(), mid.SessionID(),
		ChainParams{FinalPrompt: "first ask", ChildPrompt: "go"})
	require.NoError(t, err)
	second, err := m.CreateChain(t.Context(), parent.SessionID(), other.SessionID(),
		ChainParams{FinalPrompt: "second ask", ChildPrompt: "go"})
	require.NoError(t, err)

	// the younger chain holds while the older one drives the parent, then
	// both land with their own answers in their own order
	waitChainState(t, m, first.ID, ChainDone)
	waitChainState(t, m, second.ID, ChainDone)

	assert.Equal(t, []string{"first ask", "second ask"}, parentSubmitLines(parent))
	midLines := childSubmits(mid)
	require.Len(t, midLines, 1)
	assert.Contains(t, midLines[0], "answer for first ask")
	lines := childSubmits(other)
	require.Len(t, lines, 1)
	assert.Contains(t, lines[0], "answer for second ask")
	assert.NotContains(t, lines[0], "answer for first ask")
}

func TestChainParentExitHandsOffFromTranscript(t *testing.T) {
	m, parent := newChainFleet(t,
		prompt(t, "01U1", "", "first question"),
		assistantEntry(t, "01A1", "01U1", "old answer"))
	child := chainStub(t, m, "01CHILDSESSION00000B")

	parent.OnSubmit(func(p ctl.SubmitParams) {
		parent.Broadcast(ctl.EventTurnStart, nil) // the turn never ends live
	})
	ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
		ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue"})
	require.NoError(t, err)
	waitChainState(t, m, ch.ID, ChainFinal)

	// ajent recorded the session before the instance left: the final exchange
	// lands there under the chain's pending id
	writeSavedSession(t, parent.SessionID(),
		prompt(t, "01U1", "", "first question"),
		assistantEntry(t, "01A1", "01U1", "old answer"),
		finalPromptEntry(t, "01B1", "01A1", ch.ID, "summarize"),
		assistantEntry(t, "01B2", "01B1", "recorded after exit"))

	// the parent instance leaves discovery while its turn runs
	parent.RemoveRegistry()
	require.Eventually(t, func() bool { return m.route(parent.SessionID()) == nil },
		2*time.Second, testPoll)

	waitChainState(t, m, ch.ID, ChainDone)
	lines := childSubmits(child)
	require.Len(t, lines, 1)
	assert.Contains(t, lines[0], "recorded after exit")
	assert.NotContains(t, lines[0], "old answer")
}

func TestChainUpdateInFinalKeepsProgress(t *testing.T) {
	m, parent := newChainFleet(t,
		prompt(t, "01U1", "", "first question"),
		assistantEntry(t, "01A1", "01U1", "old answer"))
	child := chainStub(t, m, "01CHILDSESSION00000B")

	parent.OnSubmit(func(p ctl.SubmitParams) {
		parent.Broadcast(ctl.EventTurnStart, nil) // hold the final turn open
	})
	ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
		ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue"})
	require.NoError(t, err)
	waitChainState(t, m, ch.ID, ChainFinal)

	// the final prompt already runs: changing it refuses, the child prompt
	// still edits
	_, err = m.UpdateChain(t.Context(), ch.ID,
		ChainParams{FinalPrompt: "different final", ChildPrompt: "edited prompt"})
	require.ErrorIs(t, err, ErrChainEditing)
	_, err = m.UpdateChain(t.Context(), ch.ID,
		ChainParams{FinalPrompt: "summarize", ChildPrompt: "edited prompt"})
	require.NoError(t, err)
	assert.Equal(t, ChainFinal, chainStateOf(t, m, ch.ID))
	require.Never(t, func() bool { return len(submitParams(parent)) > 1 },
		3*chainWindow, chainTickEvery)

	// the landed turn ends, its response still hands off
	parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
		ID: "01U2", ParentID: "01A1", Type: string(session.TypeMessage), TS: 101,
		Data: mustJSON(session.MessageData{
			Message:  llm.Text(llm.RoleUser, "summarize"),
			QueueIDs: []string{chainFinalPendingID(ch.ID)}}),
	}})
	parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
		ID: "01A2", ParentID: "01U2", Type: string(session.TypeMessage), TS: 102,
		Data: mustJSON(session.MessageData{
			Message: llm.Text(llm.RoleAssistant, "first answer")}),
	}})
	parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})

	waitChainState(t, m, ch.ID, ChainDone)
	require.Len(t, submitParams(parent), 1) // the edited final prompt never ran
	lines := childSubmits(child)
	require.Len(t, lines, 1)
	assert.Contains(t, lines[0], "first answer")
	assert.True(t, strings.HasSuffix(lines[0], "\n\nedited prompt"))
}

func TestChainHardRefusalFails(t *testing.T) {
	m, parent := newChainFleet(t,
		prompt(t, "01U1", "", "first question"),
		assistantEntry(t, "01A1", "01U1", "recorded answer"))
	child := chainStub(t, m, "01CHILDSESSION00000B")
	child.Refuse(ctl.MethodSubmit, ctl.CodeBadRequest, "prompt is malformed")

	_, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
		ChainParams{ChildPrompt: "continue"})
	require.NoError(t, err)
	var failed Chain
	require.Eventually(t, func() bool {
		for _, ch := range m.ChainList() {
			if ch.State == ChainFailed {
				failed = ch
				return true
			}
		}
		return false
	}, 2*time.Second, testPoll)
	assert.Equal(t, "prompt is malformed", failed.Reason)
}

// TestChainStopPolicy pins stop integration: a stopped endpoint never hands
// off or receives, its stacked tail breaks with it, and a refused stop leaves
// the chain exactly as it stood.
func TestChainStopPolicy(t *testing.T) {
	t.Run("stopped_parent_never_delivers", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		parent.OnSubmit(func(p ctl.SubmitParams) {
			if p.Line == stopLine {
				parent.Exit("stopped")
			}
		})

		require.NoError(t, m.StopSession(t.Context(), parent.SessionID()))
		failed := chainStateOf(t, m, ch.ID)
		assert.Equal(t, ChainFailed, failed)
		broken, ok := m.Chain(ch.ID)
		require.True(t, ok)
		assert.Equal(t, "parent stopped", broken.Reason)
		assert.Empty(t, childSubmits(child))
	})

	t.Run("stopped_mid_breaks_the_tail", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		mid := chainStub(t, m, "01CHILDSESSION00000B")
		third := chainStub(t, m, "01THIRDSESSION000000C")

		first, err := m.CreateChain(t.Context(), parent.SessionID(), mid.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		second, err := m.CreateChain(t.Context(), mid.SessionID(), third.SessionID(),
			ChainParams{ChildPrompt: "pick it up"})
		require.NoError(t, err)
		mid.OnSubmit(func(p ctl.SubmitParams) {
			if p.Line == stopLine {
				mid.Exit("stopped")
			}
		})

		require.NoError(t, m.StopSession(t.Context(), mid.SessionID()))
		broken, ok := m.Chain(first.ID)
		require.True(t, ok)
		assert.Equal(t, ChainFailed, broken.State)
		assert.Equal(t, "child stopped", broken.Reason)
		tail, ok := m.Chain(second.ID)
		require.True(t, ok)
		assert.Equal(t, ChainFailed, tail.State)
		assert.Equal(t, "upstream child stopped", tail.Reason)
		assert.Empty(t, childSubmits(third))
	})

	t.Run("refused_stop_leaves_the_chain_armed", func(t *testing.T) {
		m, parent := newChainFleet(t)
		parent.Broadcast(ctl.EventTurnStart, nil)
		waitForRunning(t, m, parent, true)
		child := chainStub(t, m, "01CHILDSESSION00000B")

		ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
			ChainParams{ChildPrompt: "continue"})
		require.NoError(t, err)
		parent.Refuse(ctl.MethodSubmit, ctl.CodeSeatHeld, "seat held by a human")

		err = m.StopSession(t.Context(), parent.SessionID())
		require.Error(t, err)
		assert.Equal(t, ChainWaiting, chainStateOf(t, m, ch.ID))

		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		waitChainState(t, m, ch.ID, ChainDone)
		require.Len(t, childSubmits(child), 1)
	})
}

func TestChainHandoffAttribution(t *testing.T) {
	// the handoff carries the answer the final prompt earned: a human reply
	// after the chain's line owns the later responses, so the newest-text rule
	// never steals the wrong answer
	m, parent := newChainFleet(t)
	child := chainStub(t, m, "01CHILDSESSION00000B")

	parent.OnSubmit(func(p ctl.SubmitParams) {
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: "01U2", Type: string(session.TypeMessage),
			TS: 101, Data: mustJSON(session.MessageData{
				Message:  llm.Text(llm.RoleUser, p.Line),
				QueueIDs: []string{p.PendingID}}),
		}})
		parent.Broadcast(ctl.EventTurnStart, nil)
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: "01A2", ParentID: "01U2", Type: string(session.TypeMessage), TS: 102,
			Data: mustJSON(session.MessageData{
				Message: llm.Text(llm.RoleAssistant, "the chain's answer")}),
		}})
		parent.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		// the human continues the conversation before collection runs
		parent.WriteTranscript(t,
			finalPromptEntry(t, "01U3", "01A2", "human-later", "a human line"),
			assistantEntry(t, "01A3", "01U3", "a later answer"))
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: "01U3", ParentID: "01A2", Type: string(session.TypeMessage), TS: 103,
			Data: mustJSON(session.MessageData{
				Message:  llm.Text(llm.RoleUser, "a human line"),
				QueueIDs: []string{"human-later"}}),
		}})
		parent.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID: "01A3", ParentID: "01U3", Type: string(session.TypeMessage), TS: 104,
			Data: mustJSON(session.MessageData{
				Message: llm.Text(llm.RoleAssistant, "a later answer")}),
		}})
	})

	ch, err := m.CreateChain(t.Context(), parent.SessionID(), child.SessionID(),
		ChainParams{FinalPrompt: "summarize", ChildPrompt: "continue"})
	require.NoError(t, err)
	waitChainState(t, m, ch.ID, ChainDone)

	lines := childSubmits(child)
	require.Len(t, lines, 1)
	assert.Contains(t, lines[0], "the chain's answer")
	assert.NotContains(t, lines[0], "a later answer")
}

func TestChainFinalPromptRefusesDeadParent(t *testing.T) {
	// a recorded-but-not-live parent can hand off its transcript, but a final
	// prompt can never run there, so create and edit both refuse it up front
	home := testutil.IsolateHome(t)
	child := chainPersistStub(t, home, "01CHILDSESSION00000B", "child.jsonl")
	m := startChainFleetAt(t, chainFleetConfig{store: newMemChainStore()}, home)
	waitForState(t, m, child.SessionID(), ChildOnline)
	writeSavedSession(t, "01PARENTSESSION00000A",
		prompt(t, "01U1", "", "first question"),
		assistantEntry(t, "01A1", "01U1", "recorded answer"))
	require.True(t, m.savedKnown("01PARENTSESSION00000A"))

	_, err := m.CreateChain(t.Context(), "01PARENTSESSION00000A", child.SessionID(),
		ChainParams{FinalPrompt: "wrap up", ChildPrompt: "continue"})
	require.ErrorIs(t, err, ErrChainParentGone)

	// without a final prompt the dead parent still chains from its transcript
	ch, err := m.CreateChain(t.Context(), "01PARENTSESSION00000A", child.SessionID(),
		ChainParams{ChildPrompt: "continue"})
	require.NoError(t, err)
	_, err = m.UpdateChain(t.Context(), ch.ID,
		ChainParams{FinalPrompt: "too late", ChildPrompt: "continue"})
	require.ErrorIs(t, err, ErrChainParentGone)
}
