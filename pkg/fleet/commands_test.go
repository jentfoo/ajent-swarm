package fleet

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent/pkg/ctl"
)

func TestSessionCommands(t *testing.T) {
	t.Run("route_session_commands", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01CMDS000000000000"})
		f.Result(ctl.MethodInterrupt, ctl.InterruptResult{Stopped: "turn"})
		// the view seeds from backfill at attach, so the snapshot comes first
		f.SetSnapshot(ctl.State{Model: ctl.ModelState{Key: "p/m"}, Running: true})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		t.Run("unknown_session_refused", func(t *testing.T) {
			ctx := t.Context()
			require.ErrorIs(t, m.Submit(ctx, "01NOBODY00000000", ctl.SubmitParams{Line: "hi"}), ErrUnknownSession)
			_, err := m.Interrupt(ctx, "01NOBODY00000000")
			require.ErrorIs(t, err, ErrUnknownSession)
		})

		t.Run("first_write_claims_seat", func(t *testing.T) {
			require.Empty(t, f.SeatHolder()) // external sessions attach as observers
			require.NoError(t, m.Submit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "hi"}))
			assert.Equal(t, holderName, f.SeatHolder())

			var claims int
			for _, req := range f.Received() { // later writes skip the claim entirely
				if req.Method == ctl.MethodAttach {
					claims++
				}
			}
			assert.Equal(t, 1, claims)
		})

		t.Run("interrupt_carries_what_stopped", func(t *testing.T) {
			stopped, err := m.Interrupt(t.Context(), f.SessionID())
			require.NoError(t, err)
			assert.Equal(t, "turn", stopped)
		})

		t.Run("snapshot_serves_the_reconciled_state", func(t *testing.T) {
			st, err := m.Snapshot(t.Context(), f.SessionID())
			require.NoError(t, err)
			assert.Equal(t, "p/m", st.Model.Key)
			assert.True(t, st.Running)
		})
	})

	t.Run("snapshot_carries_event_watermark", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01SNAPSEQ00000000"})
		f.SetSnapshot(ctl.State{})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		ctx := t.Context()
		early, err := m.Snapshot(ctx, f.SessionID())
		require.NoError(t, err)
		assert.Zero(t, early.Queued) // nothing announced yet, so the stamp may sit low

		ev := f.Broadcast(ctl.EventQueued, ctl.QueuedData{Rows: []ctl.QueueRow{{ID: "c1", Text: "queued"}}})
		require.Eventually(t, func() bool { // the actor applies upstream events asynchronously
			snap, err := m.Snapshot(ctx, f.SessionID())
			return err == nil && snap.Queued == 1
		}, 2*time.Second, testPoll)

		snap, err := m.Snapshot(ctx, f.SessionID())
		require.NoError(t, err)
		// The read serializes beside event application on the actor goroutine, so
		// its stamp covers exactly the events the fields folded in.
		assert.Equal(t, ev.Seq, snap.Seq)
		assert.Greater(t, snap.Seq, early.Seq)
	})

	t.Run("surface_refusals", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01CMDREJECT00000", Refuses: true})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		// a displaced seat is never taken by force from a command path
		err := m.Submit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "hi"})
		require.Error(t, err)
		var wire *ctl.Error
		require.ErrorAs(t, err, &wire)
		assert.Equal(t, ctl.CodeSeatHeld, wire.Code)

		_, err = m.Interrupt(t.Context(), f.SessionID())
		require.ErrorAs(t, err, &wire)
		assert.Equal(t, ctl.CodeSeatHeld, wire.Code)
	})

	t.Run("scripted_refusals", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01CMDBUSY00000000"})
		f.Refuse(ctl.MethodSubmit, ctl.CodeBusy, "prompt queue is full")
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		err := m.Submit(t.Context(), f.SessionID(), ctl.SubmitParams{Line: "hi"})
		require.Error(t, err)
		var wire *ctl.Error
		require.ErrorAs(t, err, &wire)
		assert.Equal(t, ctl.CodeBusy, wire.Code) // retryable once the queue drains

		// the seat claim did land: only the submit itself was refused
		assert.Equal(t, holderName, f.SeatHolder())
	})

	t.Run("sub_agent_jobs", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01AGENTS00000000000"})
		f.Result(ctl.MethodAgentsList, ctl.AgentsListResult{Jobs: []ctl.AgentJob{
			{ID: "sub-1", Task: "scan the repo", Status: "running", ElapsedMS: 1200},
			{ID: "sub-2", Status: "done"},
		}})
		f.Result(ctl.MethodAgentsStop, ctl.AgentsStopResult{Stopped: 1})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		t.Run("list_answers_without_the_seat", func(t *testing.T) {
			res, err := m.AgentsList(t.Context(), f.SessionID())
			require.NoError(t, err)
			require.Len(t, res.Jobs, 2) // finished jobs ride along
			assert.Equal(t, "scan the repo", res.Jobs[0].Task)
			assert.Equal(t, "running", res.Jobs[0].Status)
			assert.Empty(t, f.SeatHolder()) // a read never claims the seat
		})

		t.Run("stop_claims_seat_and_forwards_shape", func(t *testing.T) {
			before := len(f.Received())
			res, err := m.AgentsStop(t.Context(), f.SessionID(),
				ctl.AgentsStopParams{ID: "sub-3"})
			require.NoError(t, err)
			assert.Equal(t, 1, res.Stopped) // the cancelled count passes through
			assert.Equal(t, holderName, f.SeatHolder())

			recent := f.Received()[before:]
			require.Len(t, recent, 2) // the attach claim, then the stop
			var sent ctl.AgentsStopParams
			require.NoError(t, json.Unmarshal(recent[1].Params, &sent))
			assert.Equal(t, "sub-3", sent.ID)
			assert.False(t, sent.All)
		})

		t.Run("stop_all_targets_every_inflight_job", func(t *testing.T) {
			res, err := m.AgentsStop(t.Context(), f.SessionID(), ctl.AgentsStopParams{All: true})
			require.NoError(t, err)
			assert.Equal(t, 1, res.Stopped)

			reqs := f.Received()
			var sent ctl.AgentsStopParams
			require.NoError(t, json.Unmarshal(reqs[len(reqs)-1].Params, &sent))
			assert.True(t, sent.All)
		})

		t.Run("unknown_session_refused", func(t *testing.T) {
			ctx := t.Context()
			_, err := m.AgentsList(ctx, "01NOBODY00000000000")
			require.ErrorIs(t, err, ErrUnknownSession)
			_, err = m.AgentsStop(ctx, "01NOBODY00000000000", ctl.AgentsStopParams{All: true})
			require.ErrorIs(t, err, ErrUnknownSession)
		})

		t.Run("upstream_refusals_keep_codes", func(t *testing.T) {
			f.Refuse(ctl.MethodAgentsStop, ctl.CodeNotFound, "agents.stop: no such sub-agent")
			f.Refuse(ctl.MethodAgentsList, ctl.CodeUnavailable, "sub-agents not available")

			_, err := m.AgentsList(t.Context(), f.SessionID())
			var wire *ctl.Error
			require.ErrorAs(t, err, &wire)
			assert.Equal(t, ctl.CodeUnavailable, wire.Code)

			_, err = m.AgentsStop(t.Context(), f.SessionID(), ctl.AgentsStopParams{ID: "gone"})
			require.ErrorAs(t, err, &wire)
			assert.Equal(t, ctl.CodeNotFound, wire.Code)
		})
	})
}
