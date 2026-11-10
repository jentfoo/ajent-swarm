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
	"github.com/jentfoo/ajent/pkg/ctl"
)

// ackMemStore is an in-memory AckStore for manager-level tests. The manager
// touches it from handler goroutines, so every access locks.
type ackMemStore struct {
	mu      sync.Mutex
	dialogs map[dialogAckKey]int64 // acked at, unix milliseconds
	turns   map[string]int64
}

func newAckMemStore() *ackMemStore {
	return &ackMemStore{
		dialogs: make(map[dialogAckKey]int64),
		turns:   make(map[string]int64),
	}
}

func (s *ackMemStore) AckDialog(_ context.Context,
	sessionID string, pid int, dialogID uint64, at time.Time,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dialogs[dialogAckKey{sessionID, pid, dialogID}] = at.UnixMilli()
	return nil
}

func (s *ackMemStore) AckTurn(_ context.Context,
	sessionID string, turnEnd int64, _ time.Time,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if turnEnd > s.turns[sessionID] {
		s.turns[sessionID] = turnEnd
	}
	return nil
}

func (s *ackMemStore) DialogAcks(context.Context) ([]DialogAck, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]DialogAck, 0, len(s.dialogs))
	for k, at := range s.dialogs {
		out = append(out, DialogAck{
			SessionID: k.sessionID, PID: k.pid,
			DialogID: k.dialogID, AckedAt: at,
		})
	}
	return out, nil
}

func (s *ackMemStore) TurnAcks(context.Context) (map[string]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return maps.Clone(s.turns), nil
}

func TestDeriveAttention(t *testing.T) {
	t.Parallel()

	// row builds one serving status with the digest facts a case needs.
	row := func(over func(*Status)) *Status {
		st := &Status{digestFacts: digestFacts{SessionID: "01A"}, State: ChildOnline, served: true}
		over(st)
		return st
	}

	t.Run("derives_every_kind", func(t *testing.T) {
		cases := []struct {
			name string
			st   *Status
			acks ackFacts
			want Attention
		}{
			{
				name: "open dialog raises needs input",
				st: row(func(st *Status) {
					st.OpenInteractions = 1
					st.DialogID = 7
					st.DialogPrompt = "allow write?"
					st.DialogAt = 1_000
					st.Running = true // a dialog parks the turn: input outranks running
				}),
				want: Attention{Kind: AttentionNeedsInput, Reason: "allow write?", Since: 1_000},
			},
			{
				name: "acked oldest dialog leaves a count while more wait",
				st: row(func(st *Status) {
					st.OpenInteractions = 2
					st.DialogID = 7
					st.DialogPrompt = "oldest"
					st.DialogAt = 1_000
				}),
				acks: ackFacts{dialog: true},
				want: Attention{Kind: AttentionNeedsInput, Reason: "1 more dialog(s) open",
					Since: 1_000, AckedDialog: true},
			},
			{
				name: "every dialog acked rests the session",
				st: row(func(st *Status) {
					st.OpenInteractions = 1
					st.DialogID = 7
					st.DialogPrompt = "allow write?"
				}),
				acks: ackFacts{dialog: true},
				want: Attention{Kind: AttentionAwaiting, Reason: "waiting for a prompt",
					AckedDialog: true},
			},
			{
				name: "unreviewed turn end raises needs review",
				st: row(func(st *Status) {
					st.LastTurnEnd = 900
					st.LastStop = "end_turn"
				}),
				want: Attention{Kind: AttentionNeedsReview, Reason: "turn complete", Since: 900},
			},
			{
				name: "acknowledged turn end rests the session",
				st: row(func(st *Status) {
					st.LastTurnEnd = 900
					st.LastStop = "end_turn"
				}),
				acks: ackFacts{turn: 900},
				want: Attention{Kind: AttentionAwaiting, Reason: "waiting for a prompt", AckedTurn: 900},
			},
			{
				name: "newer turn end re-raises review",
				st: row(func(st *Status) {
					st.LastTurnEnd = 1_500
					st.LastStop = "max_tokens"
				}),
				acks: ackFacts{turn: 900},
				want: Attention{Kind: AttentionNeedsReview, Reason: "stopped: max tokens",
					Since: 1_500, AckedTurn: 900},
			},
			{
				name: "busy session works",
				st: row(func(st *Status) {
					st.Running = true
					st.Activity = "reading main.go"
				}),
				want: Attention{Kind: AttentionWorking, Reason: "reading main.go"},
			},
			{
				name: "spinner counts as busy",
				st: row(func(st *Status) {
					st.Spinning = true
					st.LastTurnEnd = 900 // a stale turn end never reviews mid-spin
				}),
				want: Attention{Kind: AttentionWorking},
			},
			{
				name: "awaiting falls back to activity text",
				st:   row(func(st *Status) { st.Activity = " tests green " }),
				want: Attention{Kind: AttentionAwaiting, Reason: "tests green"},
			},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				got := deriveAttention(tc.st, tc.acks)
				assert.Equal(t, tc.want.Kind, got.Kind)
				assert.Equal(t, tc.want.Reason, got.Reason)
				assert.Equal(t, tc.want.Since, got.Since)
				assert.Equal(t, tc.want.AckedDialog, got.AckedDialog)
				assert.Equal(t, tc.want.AckedTurn, got.AckedTurn)
				assert.Equal(t, tc.st.SessionID, got.SessionID)
				assert.Equal(t, tc.st.PID, got.PID)
			})
		}
	})

	t.Run("stop_reason_text", func(t *testing.T) {
		assert.Equal(t, "turn failed", stopReasonText("end_turn", "boom"))
		assert.Equal(t, "turn complete", stopReasonText("end_turn", ""))
		assert.Equal(t, "turn finished", stopReasonText("", ""))
		assert.Equal(t, "turn finished", stopReasonText("unknown", ""))
		assert.Equal(t, "stopped: weird_new_stop", stopReasonText("weird_new_stop", ""))
	})
}

func TestManagerAcks(t *testing.T) {
	// IsolateHome pins AJENT_HOME via t.Setenv, so no t.Parallel here

	t.Run("acks_settle_digest_rows", func(t *testing.T) {
		store := newAckMemStore()
		home := testutil.IsolateHome(t)
		m := New(Options{
			Log:          testLogger(),
			PollInterval: testPoll,
			BackoffBase:  testBackoff,
			BackoffMax:   testBackoffHi,
			AckStore:     store,
		})
		m.Start(t.Context())
		t.Cleanup(m.Stop)
		ctx := t.Context()

		f := fleettest.New(t, home, fleettest.Options{SessionID: "01ACKDIGEST00000"})
		f.SetSnapshot(ctl.State{Model: ctl.ModelState{Key: "p/m"}})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)
		f.Broadcast(ctl.EventInteractionPending, ctl.InteractionPendingData{ID: 3, Prompt: "allow write?"})
		f.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})

		attention := func() Attention {
			rows := m.Attention()
			require.Len(t, rows, 1)
			return rows[0]
		}
		require.Eventually(t, func() bool {
			row := attention()
			return row.Kind == AttentionNeedsInput && row.DialogID == 3 && row.LastTurnEnd > 0
		}, 2*time.Second, testPoll)

		// the dialog ack settles needs-input even though the dialog stays open
		// upstream, and the stored row keeps the digest row's pid scope
		require.NoError(t, m.AckDialog(ctx, f.SessionID(), attention().PID, 3))
		row := attention()
		assert.Equal(t, AttentionNeedsReview, row.Kind) // the unreviewed turn surfaces next
		assert.True(t, row.AckedDialog)
		stored, err := store.DialogAcks(ctx)
		require.NoError(t, err)
		require.Len(t, stored, 1)
		assert.Equal(t, f.SessionID(), stored[0].SessionID)
		assert.Equal(t, row.PID, stored[0].PID)
		assert.Equal(t, uint64(3), stored[0].DialogID)

		require.NoError(t, m.AckTurn(ctx, f.SessionID(), row.LastTurnEnd))
		row = attention()
		assert.Equal(t, AttentionAwaiting, row.Kind)
		assert.Equal(t, row.LastTurnEnd, row.AckedTurn)
	})

	t.Run("acks_survive_restart", func(t *testing.T) {
		store := newAckMemStore()
		m := New(Options{Log: testLogger(), AckStore: store})
		ctx, cancel := context.WithCancel(t.Context())
		m.Start(ctx)
		require.NoError(t, m.AckDialog(ctx, "01A", 7, 42))
		require.NoError(t, m.AckTurn(ctx, "01A", 900))
		m.Stop()
		cancel()

		// a fresh manager over the same store loads its acks at Start
		m2 := New(Options{Log: testLogger(), AckStore: store})
		m2.Start(t.Context())
		t.Cleanup(m2.Stop)
		st := &Status{digestFacts: digestFacts{SessionID: "01A", PID: 7, OpenInteractions: 1,
			DialogID: 42, LastTurnEnd: 900}, served: true}
		assert.Equal(t, AttentionAwaiting, deriveAttention(st, m2.ackFactsFor([]*Status{st})[0]).Kind)
	})

	t.Run("acks_require_store_and_valid_targets", func(t *testing.T) {
		m := New(Options{Log: testLogger(), AckStore: newAckMemStore()})
		ctx := t.Context()

		require.ErrorIs(t, m.AckDialog(ctx, "  ", 7, 42), ErrUnknownSession)
		require.ErrorIs(t, m.AckTurn(ctx, "  ", 100), ErrUnknownSession)
		require.Error(t, m.AckDialog(ctx, "01A", 7, 0))
		require.Error(t, m.AckTurn(ctx, "01A", 0))

		bare := New(Options{Log: testLogger()})
		require.ErrorIs(t, bare.AckDialog(ctx, "01A", 7, 42), ErrNoAckStore)
		require.ErrorIs(t, bare.AckTurn(ctx, "01A", 100), ErrNoAckStore)
	})
}
