package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

func TestSessionHandlers(t *testing.T) {
	t.Run("submit_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01SUBMIT00000000000", fleettest.Options{})
		base := "/api/sessions/" + f.SessionID() + "/submit"

		t.Run("echoes_pending_row_id", func(t *testing.T) {
			code, res := post[submitReply](h, base,
				submitRequest{Line: "explain this diff", PendingID: "c1"})
			require.Equal(t, http.StatusAccepted, code)
			assert.Equal(t, "c1", res.PendingID)

			sent := receivedParams[ctl.SubmitParams](h, f, ctl.MethodSubmit)
			require.Len(t, sent, 1)
			assert.Equal(t, "explain this diff", sent[0].Line)
			assert.Equal(t, "c1", sent[0].PendingID) // the correlation rides upstream
		})

		t.Run("mints_pending_id_when_absent", func(t *testing.T) {
			code, res := post[submitReply](h, base, submitRequest{Line: "again"})
			require.Equal(t, http.StatusAccepted, code)
			assert.NotEmpty(t, res.PendingID)
		})

		t.Run("empty_line_is_refused", func(t *testing.T) {
			code, body := post[errorBody](h, base, submitRequest{Line: "   "})
			requireCoded(h, http.StatusBadRequest, codeInvalidRequest, code, body)
		})

		t.Run("oversize_pending_id_is_refused", func(t *testing.T) {
			code, body := post[errorBody](h, base,
				submitRequest{Line: "hi", PendingID: string(make([]byte, maxPendingID+1))})
			requireCoded(h, http.StatusBadRequest, codeInvalidRequest, code, body)
		})

		t.Run("busy_keeps_its_code", func(t *testing.T) {
			f.Refuse(ctl.MethodSubmit, ctl.CodeBusy, "prompt queue is full")
			code, body := post[errorBody](h, base, submitRequest{Line: "hi"})
			requireCoded(h, http.StatusConflict, ctl.CodeBusy, code, body)
		})

		t.Run("unknown_session_404_first", func(t *testing.T) {
			code, body := post[errorBody](h, "/api/sessions/01NOBODY00000000/submit",
				submitRequest{Line: "hi"})
			requireCoded(h, http.StatusNotFound, "session_not_found", code, body)
		})
	})

	t.Run("recall_lines_handler", func(t *testing.T) {
		// every case gets its own harness and store, so recorded rows never leak
		// between them
		newCase := func(t *testing.T) (*sessionHarness, *fleettest.Stub, string) {
			t.Helper()
			h := newSessionAPI(t)
			f := h.addSession("01RECLINE000000000", fleettest.Options{})
			return h, f, "/api/sessions/" + f.SessionID()
		}

		t.Run("records_typed_submits", func(t *testing.T) {
			h, _, base := newCase(t)
			code, _ := post[submitReply](h, base+"/submit",
				submitRequest{Line: "explain this diff", PendingID: "c1"})
			require.Equal(t, http.StatusAccepted, code)

			var items []store.RecallLine
			require.Eventually(t, func() bool {
				var err error
				items, err = h.st.RecallLines(h.t.Context(), "/repo", "", 10)
				return err == nil && len(items) == 1
			}, 2*time.Second, 5*time.Millisecond)
			assert.Equal(t, "explain this diff", items[0].Text)

			code, res := get[recallLinesReply](h, base+"/recall-lines")
			require.Equal(t, http.StatusOK, code)
			require.Len(t, res.Items, 1)
			assert.Equal(t, "explain this diff", res.Items[0].Text)
		})

		t.Run("slash_and_shell_never_record", func(t *testing.T) {
			h, _, base := newCase(t)
			for _, line := range []string{"/compact", "!ls -la", "!!rm -rf /"} {
				code, _ := post[submitReply](h, base+"/submit", submitRequest{Line: line})
				require.Equal(t, http.StatusAccepted, code)
			}

			rows, err := h.st.RecallLines(h.t.Context(), "/repo", "", 10)
			require.NoError(t, err)
			assert.Empty(t, rows)
		})

		t.Run("secret_line_records_withheld", func(t *testing.T) {
			h, _, base := newCase(t)
			code, _ := post[submitReply](h, base+"/submit", submitRequest{Line: "secret:hunter2"})
			require.Equal(t, http.StatusAccepted, code)

			rows, err := h.st.RecallLines(h.t.Context(), "/repo", "", 10)
			require.NoError(t, err)
			assert.Empty(t, rows) // the row exists but its text never surfaces
			code, res := get[recallLinesReply](h, base+"/recall-lines")
			require.Equal(t, http.StatusOK, code)
			assert.NotNil(t, res.Items)
			assert.Empty(t, res.Items)
		})

		t.Run("query_narrows", func(t *testing.T) {
			h, _, base := newCase(t)
			for _, line := range []string{"explain this diff", "another question"} {
				code, _ := post[submitReply](h, base+"/submit", submitRequest{Line: line})
				require.Equal(t, http.StatusAccepted, code)
			}
			require.Eventually(t, func() bool {
				rows, err := h.st.RecallLines(h.t.Context(), "/repo", "", 10)
				return err == nil && len(rows) == 2
			}, 2*time.Second, 5*time.Millisecond)

			code, res := get[recallLinesReply](h, base+"/recall-lines?query=EXPLAIN")
			require.Equal(t, http.StatusOK, code)
			require.Len(t, res.Items, 1)
			assert.Equal(t, "explain this diff", res.Items[0].Text)
		})

		t.Run("redacted_queue_row_withholds", func(t *testing.T) {
			h, f, base := newCase(t)
			code, res := post[submitReply](h, base+"/submit",
				submitRequest{Line: "queued then redacted", PendingID: "c9"})
			require.Equal(t, http.StatusAccepted, code)
			require.Equal(t, "c9", res.PendingID)
			require.Eventually(t, func() bool {
				rows, err := h.st.RecallLines(h.t.Context(), "/repo", "", 10)
				return err == nil && len(rows) == 1
			}, 2*time.Second, 5*time.Millisecond)

			// the wire redacts the row: swarm's mirror withholds its text too
			f.Broadcast(ctl.EventQueued,
				ctl.QueuedData{Rows: []ctl.QueueRow{{ID: "c9"}}})
			require.Eventually(t, func() bool {
				rows, err := h.st.RecallLines(h.t.Context(), "/repo", "", 10)
				return err == nil && len(rows) == 0
			}, 2*time.Second, 5*time.Millisecond)
		})

		t.Run("unknown_session_404", func(t *testing.T) {
			h, _, _ := newCase(t)
			code, body := get[errorBody](h, "/api/sessions/01NOBODY00000000/recall-lines")
			requireCoded(h, http.StatusNotFound, "session_not_found", code, body)
		})

		t.Run("bad_limit_refused", func(t *testing.T) {
			h, _, base := newCase(t)
			code, body := get[errorBody](h, base+"/recall-lines?limit=zero")
			requireCoded(h, http.StatusBadRequest, codeInvalidRequest, code, body)
		})
	})

	t.Run("interrupt_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01INTERRUPT0000000", fleettest.Options{})
		path := "/api/sessions/" + f.SessionID() + "/interrupt"

		t.Run("names_what_stopped", func(t *testing.T) {
			f.Result(ctl.MethodInterrupt, ctl.InterruptResult{Stopped: "shell"})
			code, res := post[interruptReply](h, path, nil)
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "shell", res.Stopped)
		})

		t.Run("held_seat_never_displaced", func(t *testing.T) {
			held := h.newStub("01HELDSEAT00000000", fleettest.Options{Refuses: true})
			h.serve(held)

			code, body := post[errorBody](h,
				"/api/sessions/"+held.SessionID()+"/interrupt", nil)
			requireCoded(h, http.StatusConflict, ctl.CodeSeatHeld, code, body)
		})
	})

	t.Run("mode_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01MODE0000000000000", fleettest.Options{})
		path := "/api/sessions/" + f.SessionID() + "/mode"
		f.Result(ctl.MethodModeCycle, ctl.ModeResult{Mode: "auto"})

		t.Run("cycles_forward_with_no_body", func(t *testing.T) {
			code, res := post[ctl.ModeResult](h, path, nil)
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "auto", res.Mode)
		})

		t.Run("back_reaches_upstream", func(t *testing.T) {
			code, _ := post[ctl.ModeResult](h, path, map[string]bool{"back": true})
			require.Equal(t, http.StatusOK, code)

			sent := receivedParams[ctl.ModeCycleParams](h, f, ctl.MethodModeCycle)
			require.Len(t, sent, 2)
			assert.False(t, sent[0].Back)
			assert.True(t, sent[1].Back)
		})

		t.Run("named_mode_upstream_set", func(t *testing.T) {
			before := len(f.Received())
			f.Result(ctl.MethodModeSet, ctl.ModeResult{Mode: "allow-all"})
			code, res := post[ctl.ModeResult](h, path, map[string]string{"mode": "allow-all"})
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "allow-all", res.Mode)

			// the jump rides mode.set alone, nothing else fired for this request
			recent := f.Received()[before:]
			require.Len(t, recent, 1)
			sent := receivedParams[ctl.ModeSetParams](h, f, ctl.MethodModeSet)[0]
			assert.Equal(t, "allow-all", sent.Mode)
		})
	})

	t.Run("rewind_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01REWIND00000000000", fleettest.Options{})
		path := "/api/sessions/" + f.SessionID() + "/rewind"
		f.Result(ctl.MethodRewind, ctl.RewindResult{Head: "m1"})

		t.Run("reports_the_new_head", func(t *testing.T) {
			code, res := post[rewindReply](h, path, rewindRequest{Head: "m1"})
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "m1", res.Head)

			sent := receivedParams[ctl.RewindParams](h, f, ctl.MethodRewind)
			require.Len(t, sent, 1)
			assert.Equal(t, "m1", sent[0].Head)
		})

		t.Run("empty_head_is_refused_locally", func(t *testing.T) {
			code, body := post[errorBody](h, path, rewindRequest{})
			requireCoded(h, http.StatusBadRequest, codeInvalidRequest, code, body)
		})

		t.Run("running_turn_keeps_refusal", func(t *testing.T) {
			f.Refuse(ctl.MethodRewind, ctl.CodeUnavailable, "a running turn owns the loop")
			code, body := post[errorBody](h, path, rewindRequest{Head: "m1"})
			requireCoded(h, http.StatusConflict, ctl.CodeUnavailable, code, body)
		})

		t.Run("unknown_head_is_not_found", func(t *testing.T) {
			f.Refuse(ctl.MethodRewind, ctl.CodeNotFound, "no such entry")
			code, body := post[errorBody](h, path, rewindRequest{Head: "gone"})
			requireCoded(h, http.StatusNotFound, ctl.CodeNotFound, code, body)
		})
	})

	t.Run("resolve_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01RESOLVE000000000", fleettest.Options{})
		path := "/api/sessions/" + f.SessionID() + "/resolve"

		t.Run("index_shape_passes_through", func(t *testing.T) {
			code, res := post[resolveReply](h, path, resolveRequest{DialogID: 7, Index: ptr(2)})
			require.Equal(t, http.StatusOK, code)
			assert.False(t, res.Settled)

			sent := receivedParams[ctl.ResolveParams](h, f, ctl.MethodResolve)
			require.Len(t, sent, 1)
			assert.Equal(t, uint64(7), sent[0].ID)
			require.NotNil(t, sent[0].Index)
			assert.Equal(t, 2, *sent[0].Index)
		})

		t.Run("indexes_shape_passes_through", func(t *testing.T) {
			code, _ := post[resolveReply](h, path,
				resolveRequest{DialogID: 8, Indexes: &[]int{1, 3}})
			require.Equal(t, http.StatusOK, code)

			sent := receivedParams[ctl.ResolveParams](h, f, ctl.MethodResolve)
			require.Len(t, sent, 2)
			require.NotNil(t, sent[1].Indexes)
			assert.Equal(t, []int{1, 3}, *sent[1].Indexes)
		})

		t.Run("cancel_resolves_plainly", func(t *testing.T) {
			code, res := post[resolveReply](h, path, resolveRequest{DialogID: 9, Cancel: true})
			require.Equal(t, http.StatusOK, code)
			assert.False(t, res.Settled)

			sent := receivedParams[ctl.ResolveParams](h, f, ctl.MethodResolve)
			require.NotEmpty(t, sent)
			last := sent[len(sent)-1]
			assert.Equal(t, uint64(9), last.ID)
			assert.True(t, last.Cancel) // cancel rides upstream, not just a 200
		})

		t.Run("two_shapes_local_400", func(t *testing.T) {
			code, body := post[errorBody](h, path,
				resolveRequest{DialogID: 7, Index: ptr(1), Cancel: true})
			requireCoded(h, http.StatusBadRequest, codeInvalidRequest, code, body)
		})

		t.Run("no_shape_local_400", func(t *testing.T) {
			code, body := post[errorBody](h, path, resolveRequest{DialogID: 7})
			requireCoded(h, http.StatusBadRequest, codeInvalidRequest, code, body)
		})

		t.Run("textless_chat_local_400", func(t *testing.T) {
			code, body := post[errorBody](h, path,
				resolveRequest{DialogID: 7, Cancel: true, Chat: true})
			requireCoded(h, http.StatusBadRequest, codeInvalidRequest, code, body)
		})

		t.Run("settled_adjacent_marker", func(t *testing.T) {
			f.Refuse(ctl.MethodResolve, ctl.CodeSettled, "first answer won")
			code, res := post[resolveReply](h, path, resolveRequest{DialogID: 7, Cancel: true})
			require.Equal(t, http.StatusOK, code)
			assert.True(t, res.Settled)
		})

		t.Run("unknown_dialog_is_not_found", func(t *testing.T) {
			f.Refuse(ctl.MethodResolve, ctl.CodeNotFound, "never seen")
			code, body := post[errorBody](h, path, resolveRequest{DialogID: 99, Cancel: true})
			requireCoded(h, http.StatusNotFound, ctl.CodeNotFound, code, body)
		})
	})

	t.Run("recall_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01RECALL00000000000", fleettest.Options{})
		path := "/api/sessions/" + f.SessionID() + "/recall"

		t.Run("empty_result_when_nothing_queued", func(t *testing.T) {
			code, res := post[ctl.RecallResult](h, path, nil)
			require.Equal(t, http.StatusOK, code)
			assert.Empty(t, res.ID)
		})

		t.Run("popped_row_echoes_whole", func(t *testing.T) {
			f.Result(ctl.MethodQueueRecall, ctl.RecallResult{ID: "c1", Text: "queued prompt"})
			code, res := post[ctl.RecallResult](h, path, nil)
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "c1", res.ID)
			assert.Equal(t, "queued prompt", res.Text)
		})

		t.Run("unavailable_refusal_passes_through", func(t *testing.T) {
			f.Refuse(ctl.MethodQueueRecall, ctl.CodeUnavailable, "run still starting")
			code, body := post[errorBody](h, path, nil)
			requireCoded(h, http.StatusConflict, ctl.CodeUnavailable, code, body)
		})
	})

	t.Run("snapshot_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.newStub("01SNAPSHOT00000000", fleettest.Options{})
		f.SetSnapshot(ctl.State{
			Model:      ctl.ModelState{Key: "p/m"},
			QueuedRows: []ctl.QueueRow{{ID: "c1", Text: "queued"}},
		})
		h.serve(f)

		t.Run("matches_the_reconciled_state", func(t *testing.T) {
			code, st := get[fleet.StampedState](h, "/api/sessions/"+f.SessionID()+"/snapshot")
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "p/m", st.Model.Key)
			assert.Equal(t, 1, st.Queued)
			assert.NotZero(t, st.Seq) // the watermark every poll-only client reconciles by

			live, err := h.mgr.Snapshot(h.t.Context(), f.SessionID())
			require.NoError(t, err)
			// compared through their wire bytes: a JSON round trip nils empty lists
			want, err := json.Marshal(live)
			require.NoError(t, err)
			got, err := json.Marshal(st)
			require.NoError(t, err)
			assert.Equal(t, string(want), string(got))
		})

		t.Run("unknown_session_is_not_found", func(t *testing.T) {
			code, _ := get[fleet.StampedState](h, "/api/sessions/01NOBODY00000000/snapshot")
			assert.Equal(t, http.StatusNotFound, code)
		})
	})

	t.Run("snapshot_under_concurrent_reads", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01SNAPCONC00000000", fleettest.Options{})

		const (
			batches = 16
			readers = 8
		)

		stop := make(chan struct{})
		ready := make(chan struct{}, readers)
		var seen [readers][]int
		var wg sync.WaitGroup
		for i := range readers {
			wg.Add(1)
			go func(i int) { // failures report through h.t, require stays off reader goroutines
				defer wg.Done()
				ready <- struct{}{}
				for {
					select {
					case <-stop:
						return
					default:
					}
					req, err := http.NewRequestWithContext(h.t.Context(), http.MethodGet,
						h.server.URL+"/api/sessions/"+f.SessionID()+"/snapshot", nil)
					if err != nil {
						h.t.Errorf("concurrent request build failed: %v", err)
						return
					}
					resp, err := h.client.Do(req)
					if err != nil {
						h.t.Errorf("concurrent read failed: %v", err)
						return
					}
					var st ctl.State
					err = json.NewDecoder(resp.Body).Decode(&st)
					_ = resp.Body.Close()
					if err != nil {
						h.t.Errorf("concurrent decode failed: %v", err)
						return
					}
					if resp.StatusCode != http.StatusOK {
						h.t.Errorf("concurrent read answered %d", resp.StatusCode)
						return
					}
					seen[i] = append(seen[i], st.Queued)
				}
			}(i)
		}
		for range readers {
			<-ready
		}

		rows := make([]ctl.QueueRow, 0, batches)
		for i := range batches { // queued events replace wholesale, so grow the list
			rows = append(rows, ctl.QueueRow{ID: "c" + string(rune('a'+i)), Text: "queued"})
			f.Broadcast(ctl.EventQueued, ctl.QueuedData{Rows: slices.Clone(rows)})
		}
		close(stop)
		wg.Wait()

		// the broadcasts apply on the actor goroutine behind the reads, so the
		// final snapshot converges asynchronously: poll until every row landed
		var st ctl.State
		require.Eventually(t, func() bool {
			req, err := http.NewRequestWithContext(h.t.Context(), http.MethodGet,
				h.server.URL+"/api/sessions/"+f.SessionID()+"/snapshot", nil)
			if err != nil {
				return false
			}
			resp, err := h.client.Do(req)
			if err != nil {
				return false
			}
			ok := resp.StatusCode == http.StatusOK &&
				json.NewDecoder(resp.Body).Decode(&st) == nil
			_ = resp.Body.Close()
			return ok && st.Queued == batches
		}, 2*time.Second, 5*time.Millisecond)

		for _, seq := range seen {
			if len(seq) == 0 { // a reader that never ran is fine
				continue
			}
			assert.LessOrEqual(t, seq[0], batches)
			for j := 1; j < len(seq); j++ {
				assert.GreaterOrEqual(t, seq[j], seq[j-1])
			}
		}
	})

	t.Run("candidates_handler", func(t *testing.T) {
		h := newSessionAPI(t)

		f := h.newStub("01CANDIDS00000000", fleettest.Options{})
		f.WriteTranscript(h.t,
			transcriptEntry(h.t, "s0", "", session.TypeSession, map[string]any{"version": 1}),
			promptEntry(h.t, "m1", "s0", "first prompt"),
			transcriptEntry(h.t, "a2", "m1", session.TypeMessage,
				session.MessageData{Message: llm.Text(llm.RoleAssistant, "assistant says hi")}),
			transcriptEntry(h.t, "r3", "a2", session.TypeMessage,
				session.MessageData{Message: llm.Message{Role: llm.RoleUser, Content: llm.BlockList{
					llm.ToolResultBlock{CallID: "c1"},
				}}}),
			transcriptEntry(h.t, "c4", "r3", session.TypeCompaction,
				map[string]any{"summary": "early context"}),
			transcriptEntry(h.t, "n5", "c4", session.TypeNotice,
				map[string]any{"message": "notice"}),
			promptEntry(h.t, "u6", "a2", "fork prompt"),
		)
		h.serve(f)

		code, res := get[fleet.RewindCandidates](h, "/api/sessions/"+f.SessionID()+"/candidates")
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "u6", res.Head) // the live snapshot's head marks the tip

		ids := make([]string, 0, len(res.Candidates))
		kinds := map[string]string{}
		labels := map[string]string{}
		for _, c := range res.Candidates {
			ids = append(ids, c.ID)
			kinds[c.ID] = c.Kind
			labels[c.ID] = c.Label
			assert.Equal(h.t, c.ID == "u6", c.IsHead)
		}
		assert.Equal(t, []string{"m1", "a2", "c4", "u6"}, ids)

		assert.Equal(t, fleet.CandidateUser, kinds["m1"])
		assert.Equal(t, "first prompt", labels["m1"])
		assert.Equal(t, fleet.CandidateAssistant, kinds["a2"])
		assert.Equal(t, "assistant says hi", labels["a2"])
		assert.Equal(t, fleet.CandidateCompaction, kinds["c4"])
		assert.Equal(t, "early context", labels["c4"])

		code, body := get[errorBody](h, "/api/sessions/01NOBODY00000000/candidates")
		requireCoded(h, http.StatusNotFound, "session_not_found", code, body)
	})

	t.Run("attention_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.newStub("01ATTENTION0000000", fleettest.Options{})
		f.SetSnapshot(ctl.State{
			Model:   ctl.ModelState{Key: "p/m"},
			Running: true,
		})
		h.serve(f)

		attention := func() []fleet.Attention {
			code, rows := get[[]fleet.Attention](h, "/api/attention")
			require.Equal(t, http.StatusOK, code)
			return rows
		}

		t.Run("working_row", func(t *testing.T) {
			require.Eventually(h.t, func() bool {
				rows := attention()
				return len(rows) == 1 && rows[0].SessionID == f.SessionID() && rows[0].Running
			}, 2*time.Second, 5*time.Millisecond)
			assert.Equal(t, fleet.AttentionWorking, attention()[0].Kind) // derived server-side
		})

		t.Run("dialog_parks_needs_input", func(t *testing.T) {
			f.Broadcast(ctl.EventActivity, ctl.ActivityRow{Key: "k", Text: "reading main.go", Rank: 1})
			f.Broadcast(ctl.EventInteractionPending, ctl.InteractionPendingData{
				ID: 3, Kind: "decision", Prompt: "allow write?\nbe careful",
			})
			require.Eventually(h.t, func() bool {
				rows := attention()
				return len(rows) == 1 && rows[0].OpenInteractions == 1 &&
					rows[0].DialogID == 3 && rows[0].DialogPrompt == "allow write? be careful" &&
					rows[0].DialogAt > 0
			}, 2*time.Second, 5*time.Millisecond)
			row := attention()[0]
			assert.Equal(t, fleet.AttentionNeedsInput, row.Kind)
			assert.Equal(t, "allow write? be careful", row.Reason)
			assert.Equal(t, row.DialogAt, row.Since)
			assert.False(t, row.AckedDialog)
		})

		t.Run("needs_input_outranks_review", func(t *testing.T) {
			f.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
			require.Eventually(h.t, func() bool {
				rows := attention()
				return len(rows) == 1 && rows[0].LastTurnEnd > 0 && !rows[0].Running &&
					rows[0].LastStop == "end_turn" && rows[0].Activity == "reading main.go"
			}, 2*time.Second, 5*time.Millisecond)
			// the dialog still parks the turn, so needs input outranks the review
			assert.Equal(t, fleet.AttentionNeedsInput, attention()[0].Kind)
		})

		t.Run("settled_drops_digest_facts", func(t *testing.T) {
			f.Broadcast(ctl.EventInteractionSettled, ctl.InteractionSettledData{ID: 3, Kind: "decision", Answered: true})
			require.Eventually(h.t, func() bool {
				rows := attention()
				return len(rows) > 0 && rows[0].OpenInteractions == 0 &&
					rows[0].DialogID == 0 && rows[0].DialogPrompt == "" && rows[0].DialogAt == 0
			}, 2*time.Second, 5*time.Millisecond)
			// the unacked turn end surfaces as a review with its one-line summary
			row := attention()[0]
			assert.Equal(t, fleet.AttentionNeedsReview, row.Kind)
			assert.Equal(t, "turn complete", row.Reason)
			assert.Equal(t, row.LastTurnEnd, row.Since)
		})

		t.Run("digest_caps_one_line", func(t *testing.T) {
			long := strings.Repeat("x", 400)
			f.Broadcast(ctl.EventInteractionPending, ctl.InteractionPendingData{ID: 4, Prompt: long})
			require.Eventually(h.t, func() bool {
				rows := attention()
				return len(rows) > 0 && rows[0].DialogID == 4
			}, 2*time.Second, 5*time.Millisecond)
			rows := attention()
			require.NotEmpty(h.t, rows)
			assert.Len(t, []rune(rows[0].DialogPrompt), fleet.MaxDigestText+1) // the ellipsis rides along
		})

		t.Run("exited_sessions_drop_out", func(t *testing.T) {
			f.Exit("all done")
			require.Eventually(h.t, func() bool { return len(attention()) == 0 },
				2*time.Second, 5*time.Millisecond)
		})
	})

	t.Run("attention_ack_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.newStub("01ATTNACK0000000000", fleettest.Options{})
		f.SetSnapshot(ctl.State{Model: ctl.ModelState{Key: "p/m"}})
		h.serve(f)

		attention := func() []fleet.Attention {
			code, rows := get[[]fleet.Attention](h, "/api/attention")
			require.Equal(t, http.StatusOK, code)
			return rows
		}
		ack := func(body any) int {
			code, _ := post[struct{}](h, "/api/attention/ack", body)
			return code
		}

		f.Broadcast(ctl.EventInteractionPending, ctl.InteractionPendingData{ID: 5, Prompt: "allow write?"})
		f.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
		require.Eventually(h.t, func() bool {
			rows := attention()
			return len(rows) == 1 && rows[0].Kind == fleet.AttentionNeedsInput &&
				rows[0].DialogID == 5 && rows[0].LastTurnEnd > 0
		}, 2*time.Second, 5*time.Millisecond)

		t.Run("dialog_ack_settles_the_digest", func(t *testing.T) {
			row := attention()[0]
			code := ack(map[string]any{"sessionId": f.SessionID(), "pid": row.PID, "dialogId": 5})
			require.Equal(t, http.StatusNoContent, code)

			// the dialog stays open upstream, yet the row settles for every device
			// and the unreviewed turn surfaces next
			require.Eventually(h.t, func() bool {
				rows := attention()
				return len(rows) == 1 && rows[0].Kind == fleet.AttentionNeedsReview &&
					rows[0].AckedDialog && rows[0].AckedTurn == 0
			}, 2*time.Second, 5*time.Millisecond)

			dialogs, err := h.st.DialogAcks(t.Context())
			require.NoError(t, err)
			require.Len(t, dialogs, 1)
			assert.Equal(t, f.SessionID(), dialogs[0].SessionID)
			assert.Equal(t, row.PID, dialogs[0].PID)
			assert.Equal(t, uint64(5), dialogs[0].DialogID)
		})

		t.Run("turn_ack_settles_the_review", func(t *testing.T) {
			turnEnd := attention()[0].LastTurnEnd
			code := ack(map[string]any{"sessionId": f.SessionID(), "turnEnd": turnEnd})
			require.Equal(t, http.StatusNoContent, code)

			require.Eventually(h.t, func() bool {
				rows := attention()
				return len(rows) == 1 && rows[0].Kind == fleet.AttentionAwaiting &&
					rows[0].AckedTurn == turnEnd
			}, 2*time.Second, 5*time.Millisecond)

			turns, err := h.st.TurnAcks(t.Context())
			require.NoError(t, err)
			assert.Equal(t, map[string]int64{f.SessionID(): turnEnd}, turns)

			// an older watermark is a benign no-op, never a step back
			code = ack(map[string]any{"sessionId": f.SessionID(), "turnEnd": turnEnd - 1})
			require.Equal(t, http.StatusNoContent, code)
			assert.Equal(t, turnEnd, attention()[0].AckedTurn)
		})

		t.Run("rejects_malformed_bodies", func(t *testing.T) {
			for _, body := range []map[string]any{
				{"sessionId": ""},            // no session
				{"sessionId": f.SessionID()}, // no target
				{"sessionId": f.SessionID(), "dialogId": 5, "turnEnd": 9}, // both targets
			} {
				require.Equal(t, http.StatusBadRequest, ack(body))
			}
			code, body := post[errorBody](h, "/api/attention/ack", jsonBody(map[string]any{
				"sessionId": f.SessionID(), "dialogId": 5, "bogus": true}))
			require.Equal(t, http.StatusBadRequest, code)
			assert.Equal(t, codeInvalidRequest, body.Error) // strict: unknown fields refuse
		})

		t.Run("requires_auth", func(t *testing.T) {
			anon := &http.Client{} // no cookie jar: nothing authenticated
			code, _ := callJSON[struct{}](h.t, anon, h.server.URL, http.MethodPost,
				"/api/attention/ack", jsonBody(map[string]any{"sessionId": "01A", "turnEnd": 1}))
			require.Equal(t, http.StatusUnauthorized, code)
		})
	})

	t.Run("models_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.newStub("01MODELS0000000000", fleettest.Options{})
		f.SetSnapshot(ctl.State{Model: ctl.ModelState{Key: "z/small", Short: "Zed Small"}})
		h.serve(f)

		t.Run("listing_reads_each_snapshot", func(t *testing.T) {
			code, rows := get[[]fleet.ModelRow](h, "/api/models")
			require.Equal(t, http.StatusOK, code)
			require.Len(t, rows, 1)
			assert.Equal(t, f.SessionID(), rows[0].SessionID)
			assert.Equal(t, "z/small", rows[0].Current.Key)
		})
	})

	t.Run("agents_handler", func(t *testing.T) {
		h := newSessionAPI(t)
		f := h.addSession("01AGENTS00000000000", fleettest.Options{})
		base := "/api/sessions/" + f.SessionID()
		f.Result(ctl.MethodAgentsList, ctl.AgentsListResult{Jobs: []ctl.AgentJob{
			{ID: "sub-1", Task: "scan the repo", Status: "running", ElapsedMS: 1200},
			{ID: "sub-2", Status: "done"},
		}})

		t.Run("listing_passes_records_through", func(t *testing.T) {
			code, res := get[agentsListReply](h, base+"/agents")
			require.Equal(t, http.StatusOK, code)
			require.Len(t, res.Jobs, 2) // finished jobs ride along
			assert.Equal(t, "sub-1", res.Jobs[0].ID)
			assert.Equal(t, "scan the repo", res.Jobs[0].Task)
			assert.Equal(t, "running", res.Jobs[0].Status)
		})

		t.Run("empty_listing_encodes_a_list", func(t *testing.T) {
			f.Result(ctl.MethodAgentsList, ctl.AgentsListResult{})
			resp := call(t, h.client, h.server.URL, http.MethodGet, base+"/agents", nil)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			raw, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			// raw text: a typed decode would accept null silently
			assert.JSONEq(t, `{"jobs":[]}`, strings.TrimSpace(string(raw)))
		})

		t.Run("stop_forwards_the_shape", func(t *testing.T) {
			f.Result(ctl.MethodAgentsStop, ctl.AgentsStopResult{Stopped: 3})
			code, res := post[ctl.AgentsStopResult](h, base+"/agents/stop",
				agentsStopRequest{All: true})
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, 3, res.Stopped) // the cancelled count passes through

			sent := receivedParams[ctl.AgentsStopParams](h, f, ctl.MethodAgentsStop)
			require.Len(t, sent, 1)
			assert.True(t, sent[0].All)
			assert.Empty(t, sent[0].ID)
		})

		t.Run("stop_one_forwards_its_id", func(t *testing.T) {
			code, _ := post[ctl.AgentsStopResult](h, base+"/agents/stop",
				agentsStopRequest{ID: "sub-2"})
			require.Equal(t, http.StatusOK, code)
			assert.Equal(t, "sub-2", receivedParams[ctl.AgentsStopParams](h, f,
				ctl.MethodAgentsStop)[1].ID)
		})

		t.Run("unwired_session_refusal_keeps_its_code", func(t *testing.T) {
			f.Refuse(ctl.MethodAgentsList, ctl.CodeUnavailable, "sub-agents not available")
			f.Refuse(ctl.MethodAgentsStop, ctl.CodeUnavailable, "sub-agents not available")
			code, body := get[errorBody](h, base+"/agents")
			requireCoded(h, http.StatusConflict, ctl.CodeUnavailable, code, body)
			code, body = post[errorBody](h, base+"/agents/stop", agentsStopRequest{All: true})
			requireCoded(h, http.StatusConflict, ctl.CodeUnavailable, code, body)
		})

		t.Run("unknown_targets_map_not_found", func(t *testing.T) {
			f.Refuse(ctl.MethodAgentsStop, ctl.CodeNotFound, "no such sub-agent")
			code, body := post[errorBody](h, base+"/agents/stop", agentsStopRequest{ID: "gone"})
			requireCoded(h, http.StatusNotFound, ctl.CodeNotFound, code, body)

			code, body = post[errorBody](h, "/api/sessions/01NOBODY00000000/agents/stop",
				agentsStopRequest{All: true})
			requireCoded(h, http.StatusNotFound, "session_not_found", code, body)
			code, _ = get[errorBody](h, "/api/sessions/01NOBODY00000000/agents")
			require.Equal(t, http.StatusNotFound, code)
		})

		t.Run("exactly_one_shape_is_upstreams_rule", func(t *testing.T) {
			f.Refuse(ctl.MethodAgentsStop, ctl.CodeBadRequest, "takes exactly one of id or all")
			for _, shape := range []agentsStopRequest{
				{},                       // neither
				{ID: "sub-1", All: true}, // both
			} {
				code, body := post[errorBody](h, base+"/agents/stop", shape)
				requireCoded(h, http.StatusBadRequest, ctl.CodeBadRequest, code, body)
			}
		})

		t.Run("held_seat_is_never_displaced", func(t *testing.T) {
			held := h.newStub("01HELDAGENTS000000", fleettest.Options{Refuses: true})
			h.serve(held)
			code, body := post[errorBody](h,
				"/api/sessions/"+held.SessionID()+"/agents/stop", agentsStopRequest{All: true})
			requireCoded(h, http.StatusConflict, ctl.CodeSeatHeld, code, body)
		})
	})

	t.Run("write_command_failure", func(t *testing.T) {
		t.Run("coded_errors_keep_their_code", func(t *testing.T) {
			w := httptest.NewRecorder()
			writeCommandFailure(w, ctl.Errf(ctl.CodeBusy, "queue is full"))
			assert.Equal(t, http.StatusConflict, w.Code)

			var body errorBody
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
			assert.Equal(t, ctl.CodeBusy, body.Error)
			assert.Contains(t, body.Message, "queue is full")
		})

		t.Run("other_errors_answer_internal", func(t *testing.T) {
			w := httptest.NewRecorder()
			writeCommandFailure(w, errors.New("transport lost"))
			assert.Equal(t, http.StatusInternalServerError, w.Code)
		})
	})
}
