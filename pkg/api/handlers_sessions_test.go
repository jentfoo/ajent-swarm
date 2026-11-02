package api

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/paths"
	"github.com/jentfoo/ajent/pkg/session"
)

// sessionHarness serves the phase 05 endpoints over a temp ajent home whose
// fleet discovers real stub sessions.
type sessionHarness struct {
	t      *testing.T
	server *httptest.Server
	client *http.Client
	mgr    *fleet.Manager
}

// newSessionAPI builds the harness with an authenticated client. The ajent
// home stays short, since unix socket paths cap at ~108 bytes.
func newSessionAPI(t *testing.T) *sessionHarness {
	t.Helper()
	home, err := os.MkdirTemp("", "sessapi")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv(paths.EnvHome, home)

	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	svc, err := auth.NewService(st, auth.WithBcryptCost(bcrypt.MinCost))
	require.NoError(t, err)
	require.NoError(t, svc.EnsureUser(t.Context(), "jent"))

	mgr := fleet.New(fleet.Options{
		Log:          testLogger(),
		PollInterval: 10 * time.Millisecond,
		BackoffBase:  5 * time.Millisecond,
		BackoffMax:   50 * time.Millisecond,
	})
	mgr.Start(t.Context())
	t.Cleanup(mgr.Stop)

	server := httptest.NewServer(Handler(Config{Auth: svc, Fleet: mgr, Log: testLogger()}))
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar}
	bootstrapAndLogin(t, client, server.URL)
	return &sessionHarness{t: t, server: server, client: client, mgr: mgr}
}

// newStub binds one stub session without the fleet watching it yet, so tests
// can script snapshots and transcripts before attach.
func (h *sessionHarness) newStub(id string, opts fleettest.Options) *fleettest.Stub {
	h.t.Helper()
	opts.SessionID = id
	return fleettest.New(h.t, os.Getenv(paths.EnvHome), opts)
}

// serve publishes a stub's registry record and waits for the fleet to attach.
func (h *sessionHarness) serve(f *fleettest.Stub) {
	h.t.Helper()
	f.WriteRegistry(h.t, os.Getpid(), time.Now())
	h.awaitOnline(f)
}

func (h *sessionHarness) awaitOnline(f *fleettest.Stub) {
	h.t.Helper()
	require.Eventually(h.t, func() bool {
		for _, st := range h.mgr.Sessions() {
			if st.SessionID == f.SessionID() && st.State == fleet.ChildOnline {
				return true
			}
		}
		return false
	}, 2*time.Second, 5*time.Millisecond)
}

// addSession registers one stub session and waits for the fleet to attach.
func (h *sessionHarness) addSession(id string, opts fleettest.Options) *fleettest.Stub {
	h.t.Helper()
	f := h.newStub(id, opts)
	h.serve(f)
	return f
}

// get issues one authenticated GET and decodes the body into T.
func get[T any](h *sessionHarness, path string) (int, T) {
	h.t.Helper()
	return callJSON[T](h.t, h.client, h.server.URL, http.MethodGet, path, nil)
}

// post issues one authenticated POST with a JSON body and decodes into T.
func post[T any](h *sessionHarness, path string, body any) (int, T) {
	h.t.Helper()
	return callJSON[T](h.t, h.client, h.server.URL, http.MethodPost, path, body)
}

// requireCoded asserts one refusal reached the browser with its code intact.
func requireCoded(h *sessionHarness, status int, wantCode string, got int, body errorBody) {
	h.t.Helper()
	require.Equal(h.t, status, got)
	assert.Equal(h.t, wantCode, body.Error)
}

// receivedParams collects every recorded request of one method, decoded.
func receivedParams[T any](h *sessionHarness, f *fleettest.Stub, method string) []T {
	h.t.Helper()
	var out []T
	for _, req := range f.Received() {
		if req.Method != method {
			continue
		}
		var p T
		require.NoError(h.t, json.Unmarshal(req.Params, &p))
		out = append(out, p)
	}
	return out
}

func ptr[T any](v T) *T { return &v }

// transcriptEntry marshals one payload into a stub transcript entry.
func transcriptEntry(t *testing.T, id, parent string, typ session.Type, data any) fleettest.Entry {
	t.Helper()
	raw, err := json.Marshal(data)
	require.NoError(t, err)
	return fleettest.Entry{ID: id, ParentID: parent, Type: typ, TS: 100, Data: raw}
}

// promptEntry builds one user-prompt transcript entry.
func promptEntry(t *testing.T, id, parent, text string) fleettest.Entry {
	t.Helper()
	return transcriptEntry(t, id, parent, session.TypeMessage,
		session.MessageData{Message: llm.Text(llm.RoleUser, text)})
}

func TestSubmitHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.addSession("01SUBMIT00000000000", fleettest.Options{})
	base := "/api/sessions/" + f.SessionID() + "/submit"

	t.Run("success echoes the pending row id", func(t *testing.T) {
		code, res := post[submitReply](h, base,
			submitRequest{Line: "explain this diff", PendingID: "c1"})
		require.Equal(t, http.StatusAccepted, code)
		assert.Equal(t, "c1", res.PendingID)

		sent := receivedParams[ctl.SubmitParams](h, f, ctl.MethodSubmit)
		require.Len(t, sent, 1)
		assert.Equal(t, "explain this diff", sent[0].Line)
		assert.Equal(t, "c1", sent[0].PendingID) // the correlation rides upstream
	})

	t.Run("mints a pending id when absent", func(t *testing.T) {
		code, res := post[submitReply](h, base, submitRequest{Line: "again"})
		require.Equal(t, http.StatusAccepted, code)
		assert.NotEmpty(t, res.PendingID)
	})

	t.Run("empty line is refused", func(t *testing.T) {
		code, body := post[errorBody](h, base, submitRequest{Line: "   "})
		requireCoded(h, http.StatusBadRequest, "invalid_request", code, body)
	})

	t.Run("oversize pending id is refused", func(t *testing.T) {
		code, body := post[errorBody](h, base,
			submitRequest{Line: "hi", PendingID: string(make([]byte, maxPendingID+1))})
		requireCoded(h, http.StatusBadRequest, "invalid_request", code, body)
	})

	t.Run("busy keeps its code", func(t *testing.T) {
		f.Refuse(ctl.MethodSubmit, ctl.CodeBusy, "prompt queue is full")
		code, body := post[errorBody](h, base, submitRequest{Line: "hi"})
		requireCoded(h, http.StatusConflict, ctl.CodeBusy, code, body)
	})

	t.Run("unknown session is 404 before dialing", func(t *testing.T) {
		code, body := post[errorBody](h, "/api/sessions/01NOBODY00000000/submit",
			submitRequest{Line: "hi"})
		requireCoded(h, http.StatusNotFound, "session_not_found", code, body)
	})
}

func TestInterruptHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.addSession("01INTERRUPT0000000", fleettest.Options{})
	path := "/api/sessions/" + f.SessionID() + "/interrupt"

	t.Run("names what stopped", func(t *testing.T) {
		f.Result(ctl.MethodInterrupt, ctl.InterruptResult{Stopped: "shell"})
		code, res := post[interruptReply](h, path, nil)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "shell", res.Stopped)
	})

	t.Run("empty when nothing ran", func(t *testing.T) {
		f.Result(ctl.MethodInterrupt, ctl.InterruptResult{})
		code, res := post[interruptReply](h, path, nil)
		require.Equal(t, http.StatusOK, code)
		assert.Empty(t, res.Stopped)
	})

	t.Run("a held seat is never displaced", func(t *testing.T) {
		held := h.newStub("01HELDSEAT00000000", fleettest.Options{Refuses: true})
		h.serve(held)

		code, body := post[errorBody](h,
			"/api/sessions/"+held.SessionID()+"/interrupt", nil)
		requireCoded(h, http.StatusConflict, ctl.CodeSeatHeld, code, body)
	})
}

func TestModeHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.addSession("01MODE0000000000000", fleettest.Options{})
	path := "/api/sessions/" + f.SessionID() + "/mode"
	f.Result(ctl.MethodModeCycle, ctl.ModeResult{Mode: "auto"})

	t.Run("cycles forward with no body", func(t *testing.T) {
		code, res := post[ctl.ModeResult](h, path, nil)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "auto", res.Mode)
	})

	t.Run("back reaches upstream", func(t *testing.T) {
		code, _ := post[ctl.ModeResult](h, path, map[string]bool{"back": true})
		require.Equal(t, http.StatusOK, code)

		sent := receivedParams[ctl.ModeCycleParams](h, f, ctl.MethodModeCycle)
		require.Len(t, sent, 2)
		assert.False(t, sent[0].Back)
		assert.True(t, sent[1].Back)
	})
}

func TestRewindHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.addSession("01REWIND00000000000", fleettest.Options{})
	path := "/api/sessions/" + f.SessionID() + "/rewind"
	f.Result(ctl.MethodRewind, ctl.RewindResult{Head: "m1"})

	t.Run("reports the new head", func(t *testing.T) {
		code, res := post[rewindReply](h, path, rewindRequest{Head: "m1"})
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "m1", res.Head)

		sent := receivedParams[ctl.RewindParams](h, f, ctl.MethodRewind)
		require.Len(t, sent, 1)
		assert.Equal(t, "m1", sent[0].Head)
	})

	t.Run("empty head is refused locally", func(t *testing.T) {
		code, body := post[errorBody](h, path, rewindRequest{})
		requireCoded(h, http.StatusBadRequest, "invalid_request", code, body)
	})

	t.Run("a running turn keeps its refusal", func(t *testing.T) {
		f.Refuse(ctl.MethodRewind, ctl.CodeUnavailable, "a running turn owns the loop")
		code, body := post[errorBody](h, path, rewindRequest{Head: "m1"})
		requireCoded(h, http.StatusConflict, ctl.CodeUnavailable, code, body)
	})

	t.Run("unknown head is not found", func(t *testing.T) {
		f.Refuse(ctl.MethodRewind, ctl.CodeNotFound, "no such entry")
		code, body := post[errorBody](h, path, rewindRequest{Head: "gone"})
		requireCoded(h, http.StatusNotFound, ctl.CodeNotFound, code, body)
	})
}

func TestResolveHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.addSession("01RESOLVE000000000", fleettest.Options{})
	path := "/api/sessions/" + f.SessionID() + "/resolve"

	t.Run("index shape passes through", func(t *testing.T) {
		code, res := post[resolveReply](h, path, resolveRequest{DialogID: 7, Index: ptr(2)})
		require.Equal(t, http.StatusOK, code)
		assert.False(t, res.Settled)

		sent := receivedParams[ctl.ResolveParams](h, f, ctl.MethodResolve)
		require.Len(t, sent, 1)
		assert.Equal(t, uint64(7), sent[0].ID)
		require.NotNil(t, sent[0].Index)
		assert.Equal(t, 2, *sent[0].Index)
	})

	t.Run("indexes shape passes through", func(t *testing.T) {
		code, _ := post[resolveReply](h, path,
			resolveRequest{DialogID: 8, Indexes: &[]int{1, 3}})
		require.Equal(t, http.StatusOK, code)

		sent := receivedParams[ctl.ResolveParams](h, f, ctl.MethodResolve)
		require.Len(t, sent, 2)
		require.NotNil(t, sent[1].Indexes)
		assert.Equal(t, []int{1, 3}, *sent[1].Indexes)
	})

	t.Run("cancel resolves plainly", func(t *testing.T) {
		code, res := post[resolveReply](h, path, resolveRequest{DialogID: 9, Cancel: true})
		require.Equal(t, http.StatusOK, code)
		assert.False(t, res.Settled)
	})

	t.Run("two shapes are a local bad request", func(t *testing.T) {
		code, body := post[errorBody](h, path,
			resolveRequest{DialogID: 7, Index: ptr(1), Cancel: true})
		requireCoded(h, http.StatusBadRequest, "invalid_request", code, body)
	})

	t.Run("no shape is a local bad request", func(t *testing.T) {
		code, body := post[errorBody](h, path, resolveRequest{DialogID: 7})
		requireCoded(h, http.StatusBadRequest, "invalid_request", code, body)
	})

	t.Run("chat without text is a local bad request", func(t *testing.T) {
		code, body := post[errorBody](h, path,
			resolveRequest{DialogID: 7, Cancel: true, Chat: true})
		requireCoded(h, http.StatusBadRequest, "invalid_request", code, body)
	})

	t.Run("settled is success adjacent with a marker", func(t *testing.T) {
		f.Refuse(ctl.MethodResolve, ctl.CodeSettled, "first answer won")
		code, res := post[resolveReply](h, path, resolveRequest{DialogID: 7, Cancel: true})
		require.Equal(t, http.StatusOK, code)
		assert.True(t, res.Settled)
	})

	t.Run("unknown dialog is not found", func(t *testing.T) {
		f.Refuse(ctl.MethodResolve, ctl.CodeNotFound, "never seen")
		code, body := post[errorBody](h, path, resolveRequest{DialogID: 99, Cancel: true})
		requireCoded(h, http.StatusNotFound, ctl.CodeNotFound, code, body)
	})
}

func TestRecallHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.addSession("01RECALL00000000000", fleettest.Options{})
	path := "/api/sessions/" + f.SessionID() + "/recall"

	t.Run("empty result when nothing queued", func(t *testing.T) {
		code, res := post[ctl.RecallResult](h, path, nil)
		require.Equal(t, http.StatusOK, code)
		assert.Empty(t, res.ID)
	})

	t.Run("popped row echoes whole", func(t *testing.T) {
		f.Result(ctl.MethodQueueRecall, ctl.RecallResult{ID: "c1", Text: "queued prompt"})
		code, res := post[ctl.RecallResult](h, path, nil)
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "c1", res.ID)
		assert.Equal(t, "queued prompt", res.Text)
	})

	t.Run("unavailable refusal passes through", func(t *testing.T) {
		f.Refuse(ctl.MethodQueueRecall, ctl.CodeUnavailable, "run still starting")
		code, body := post[errorBody](h, path, nil)
		requireCoded(h, http.StatusConflict, ctl.CodeUnavailable, code, body)
	})
}

func TestSessionSnapshotHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.newStub("01SNAPSHOT00000000", fleettest.Options{})
	f.SetSnapshot(ctl.State{
		Model:      ctl.ModelState{Key: "p/m"},
		QueuedRows: []ctl.QueueRow{{ID: "c1", Text: "queued"}},
	})
	h.serve(f)

	t.Run("matches the reconciled state", func(t *testing.T) {
		code, st := get[ctl.State](h, "/api/sessions/"+f.SessionID()+"/snapshot")
		require.Equal(t, http.StatusOK, code)
		assert.Equal(t, "p/m", st.Model.Key)
		assert.Equal(t, 1, st.Queued)

		live, err := h.mgr.Snapshot(h.t.Context(), f.SessionID())
		require.NoError(t, err)
		// compared through their wire bytes: a JSON round trip nils empty lists
		want, err := json.Marshal(live)
		require.NoError(t, err)
		got, err := json.Marshal(st)
		require.NoError(t, err)
		assert.Equal(t, string(want), string(got))
	})

	t.Run("unknown session is not found", func(t *testing.T) {
		code, _ := get[ctl.State](h, "/api/sessions/01NOBODY00000000/snapshot")
		assert.Equal(t, http.StatusNotFound, code)
	})
}

func TestSnapshotUnderConcurrentReads(t *testing.T) {
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
		go func(i int) { // assert stays off the test goroutine
			defer wg.Done()
			ready <- struct{}{}
			for {
				select {
				case <-stop:
					return
				default:
				}
				code, st := get[ctl.State](h, "/api/sessions/"+f.SessionID()+"/snapshot")
				if code != http.StatusOK {
					h.t.Errorf("concurrent read answered %d", code)
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

	code, st := get[ctl.State](h, "/api/sessions/"+f.SessionID()+"/snapshot")
	require.Equal(t, http.StatusOK, code)
	assert.Equal(t, batches, st.Queued) // the actor state every read converges on

	for i, seq := range seen {
		if len(seq) == 0 { // a reader that never ran is fine
			continue
		}
		assert.LessOrEqual(t, seq[0], batches, "reader %d saw the future", i)
		for j := 1; j < len(seq); j++ {
			assert.GreaterOrEqual(t, seq[j], seq[j-1], "reader %d went backwards", i)
		}
	}
}

func TestCandidatesHandler(t *testing.T) {
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
		assert.Equal(h.t, c.ID == "u6", c.IsHead, "candidate %s head mark", c.ID)
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
}

func TestAttentionHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.newStub("01ATTENTION0000000", fleettest.Options{})
	f.SetSnapshot(ctl.State{
		Model:   ctl.ModelState{Key: "p/m"},
		Running: true,
	})
	h.serve(f)

	require.Eventually(h.t, func() bool {
		rows := h.mgr.Attention()
		return len(rows) == 1 && rows[0].SessionID == f.SessionID() && rows[0].Running
	}, 2*time.Second, 5*time.Millisecond)

	f.Broadcast(ctl.EventActivity, ctl.ActivityRow{Key: "k", Text: "reading main.go", Rank: 1})
	f.Broadcast(ctl.EventInteractionPending, ctl.InteractionPendingData{
		ID: 3, Kind: "decision", Prompt: "allow write?\nbe careful",
	})
	require.Eventually(h.t, func() bool {
		rows := h.mgr.Attention()
		row := rows[0]
		return len(rows) == 1 && row.OpenInteractions == 1 &&
			row.DialogID == 3 && row.DialogPrompt == "allow write? be careful" && row.DialogAt > 0
	}, 2*time.Second, 5*time.Millisecond)

	f.Broadcast(ctl.EventTurnEnd, ctl.TurnEndData{Stop: "end_turn"})
	require.Eventually(h.t, func() bool {
		rows := h.mgr.Attention()
		row := rows[0]
		return len(rows) == 1 && row.LastTurnEnd > 0 && !row.Running &&
			row.LastStop == "end_turn" && row.Activity == "reading main.go"
	}, 2*time.Second, 5*time.Millisecond)

	t.Run("settled dialogs drop their digest facts", func(t *testing.T) {
		f.Broadcast(ctl.EventInteractionSettled, ctl.InteractionSettledData{ID: 3, Kind: "decision", Answered: true})
		require.Eventually(h.t, func() bool {
			row := h.mgr.Attention()[0]
			return row.OpenInteractions == 0 && row.DialogID == 0 && row.DialogPrompt == "" && row.DialogAt == 0
		}, 2*time.Second, 5*time.Millisecond)
	})

	t.Run("digest text caps at one bounded line", func(t *testing.T) {
		long := strings.Repeat("x", 400)
		f.Broadcast(ctl.EventInteractionPending, ctl.InteractionPendingData{ID: 4, Prompt: long})
		require.Eventually(h.t, func() bool {
			row := h.mgr.Attention()[0]
			return row.DialogID == 4
		}, 2*time.Second, 5*time.Millisecond)
		row := h.mgr.Attention()[0]
		assert.Len(t, []rune(row.DialogPrompt), fleet.MaxDigestText+1) // the ellipsis rides along
	})

	t.Run("exited sessions drop out", func(t *testing.T) {
		f.Exit("all done")
		require.Eventually(h.t, func() bool { return len(h.mgr.Attention()) == 0 },
			2*time.Second, 5*time.Millisecond)
	})
}

func TestModelsHandler(t *testing.T) {
	h := newSessionAPI(t)
	f := h.newStub("01MODELS0000000000", fleettest.Options{})
	f.SetSnapshot(ctl.State{Model: ctl.ModelState{Key: "z/small", Short: "Zed Small"}})
	h.serve(f)

	t.Run("listing reads each snapshot", func(t *testing.T) {
		code, rows := get[[]fleet.ModelRow](h, "/api/models")
		require.Equal(t, http.StatusOK, code)
		require.Len(t, rows, 1)
		assert.Equal(t, f.SessionID(), rows[0].SessionID)
		assert.Equal(t, "z/small", rows[0].Current.Key)
		assert.Empty(t, rows[0].Options) // no discovery without a session query
	})

	t.Run("discovery opens and keeps the picker open", func(t *testing.T) {
		f.OpenPickerOnSubmit([]string{"Zed Small", "Zed Big"})
		code, rows := get[[]fleet.ModelRow](h, "/api/models?session="+f.SessionID())
		require.Equal(t, http.StatusOK, code)
		require.Len(t, rows, 1)
		row := rows[0]
		assert.Equal(t, "z/small", row.Current.Key)
		assert.Equal(t, []string{"Zed Small", "Zed Big"}, row.Options)
		require.NotZero(t, row.DialogID)

		// the dialog stays open on purpose: answering it is /resolve's job
		code, res := post[resolveReply](h,
			"/api/sessions/"+f.SessionID()+"/resolve",
			resolveRequest{DialogID: row.DialogID, Cancel: true})
		require.Equal(t, http.StatusOK, code)
		assert.False(t, res.Settled)

		var cancelled bool
		for _, p := range receivedParams[ctl.ResolveParams](h, f, ctl.MethodResolve) {
			cancelled = cancelled || (p.ID == row.DialogID && p.Cancel)
		}
		assert.True(t, cancelled, "the picker dialog was not cancelled upstream")
	})

	t.Run("no picker is a refusal, leaving nothing behind", func(t *testing.T) {
		f.OpenPickerOnSubmit(nil) // /model answers but never opens a dialog
		code, body := get[errorBody](h, "/api/models?session="+f.SessionID())
		requireCoded(h, http.StatusConflict, ctl.CodeUnavailable, code, body)
	})

	t.Run("running turn refuses discovery", func(t *testing.T) {
		f.Broadcast(ctl.EventTurnStart, ctl.TurnStartData{Model: "z/small"})
		code, body := get[errorBody](h, "/api/models?session="+f.SessionID())
		requireCoded(h, http.StatusConflict, ctl.CodeUnavailable, code, body)
	})

	t.Run("unknown session is not found", func(t *testing.T) {
		// the refusal envelope is an object, so decode nothing
		resp := call(h.t, h.client, h.server.URL, http.MethodGet,
			"/api/models?session=01NOBODY00000000", nil)
		assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	})
}
