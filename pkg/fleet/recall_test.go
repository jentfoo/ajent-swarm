package fleet

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent-swarm/pkg/testutil"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// fakeRecallStore records what the actors mirror, so tests assert on the
// rows a submit path wrote and the scrubs a commit or redaction applied.
type fakeRecallStore struct {
	mu     sync.Mutex
	rows   map[int64]recallRow
	nextID int64
	scrubs []int64
}

type recallRow struct {
	workspace string
	text      string
	at        time.Time
}

func newFakeRecallStore() *fakeRecallStore {
	return &fakeRecallStore{rows: make(map[int64]recallRow), nextID: 100}
}

func (f *fakeRecallStore) RecordRecallLine(_ context.Context, workspace, text string, at time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.rows[f.nextID] = recallRow{workspace: workspace, text: text, at: at}
	return f.nextID, nil
}

func (f *fakeRecallStore) ScrubRecallLine(_ context.Context, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	row, ok := f.rows[id]
	if !ok {
		return assert.AnError
	}
	f.scrubs = append(f.scrubs, id)
	row.text = ""
	f.rows[id] = row
	return nil
}

func (f *fakeRecallStore) RecallLines(_ context.Context, workspace, _ string, _ int) ([]RecallLine, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []RecallLine
	for id, row := range f.rows {
		if row.workspace != workspace || row.text == "" {
			continue
		}
		out = append(out, RecallLine{ID: id, Text: row.text, CreatedAt: row.at})
	}
	return out, nil
}

func (f *fakeRecallStore) texts() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.rows))
	for _, row := range f.rows {
		out = append(out, row.workspace+"|"+row.text)
	}
	return out
}

func (f *fakeRecallStore) scrubbed() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int64(nil), f.scrubs...)
}

// recallFleet starts a manager with the fake recall store over one stub
// session serving the usual /repo workspace.
func recallFleet(t *testing.T, rs *fakeRecallStore) (*Manager, *fleettest.Stub) {
	t.Helper()
	home := testutil.IsolateHome(t)
	m := New(Options{
		Log:          testLogger(),
		PollInterval: testPoll,
		BackoffBase:  testBackoff,
		BackoffMax:   testBackoffHi,
		RecallStore:  rs,
	})
	m.Start(t.Context())
	t.Cleanup(m.Stop)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01RECALL000000000000"})
	f.SetSnapshot(ctl.State{Workspace: "/repo"})
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitForState(t, m, f.SessionID(), ChildOnline)
	return m, f
}

// promptCommit broadcasts one committed user prompt naming the given pending
// rows, injected when asked.
func promptCommit(t *testing.T, f *fleettest.Stub, id string, injected bool, queueIDs ...string) {
	t.Helper()
	data, err := json.Marshal(session.MessageData{
		Message:  llm.Text(llm.RoleUser, "typed body"),
		Injected: injected,
		QueueIDs: queueIDs,
	})
	require.NoError(t, err)
	f.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: wireEntry(session.Entry{
		ID: id, Type: session.TypeMessage, TS: 100, Data: data,
	})})
}

// waitForCommit waits until the actor's view head reaches id, so the commit's
// mailbox processing is done before assertions read the store.
func waitForCommit(t *testing.T, m *Manager, sessionID, id string) {
	t.Helper()
	require.Eventually(t, func() bool {
		snap, err := m.Snapshot(t.Context(), sessionID)
		return err == nil && snap.Head == id
	}, 2*time.Second, testPoll)
}

func TestSubmitTrackedRecall(t *testing.T) {
	t.Run("typed_prompt_records", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "explain this diff", PendingID: "c1"}))

		assert.Contains(t, rs.texts(), "/repo|explain this diff")
		assert.Empty(t, rs.scrubbed()) // nothing contradicts the row yet
	})

	t.Run("slash_and_shell_never_record", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		for _, line := range []string{"/compact", "!ls -la", "!!rm -rf /"} {
			require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
				ctl.SubmitParams{Line: line, PendingID: "c1"}))
		}
		assert.Empty(t, rs.texts())
	})

	t.Run("escaped_lines_are_prompts", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "//not a command", PendingID: "c1"}))
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "/pasted\nmulti line", PendingID: "c2"}))
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: " ordinary prompt", PendingID: "c3"}))

		assert.Contains(t, rs.texts(), "/repo|//not a command")
		assert.Contains(t, rs.texts(), "/repo|/pasted\nmulti line")
		assert.Contains(t, rs.texts(), "/repo| ordinary prompt")
	})

	t.Run("secret_prefix_records_withheld", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "secret:hunter2", PendingID: "c1"}))
		// the one-space editor escape never saves a secret line upstream either:
		// appendHistory tests the escape-stripped form
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: " secret:hunter2", PendingID: "c2"}))
		// one space is the whole escape, so this remainder is an ordinary prompt
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: " escaped secret:of mine", PendingID: "c3"}))

		assert.Contains(t, rs.texts(), "/repo|") // both withheld rows exist
		assert.NotContains(t, rs.texts(), "/repo|secret:hunter2")
		assert.NotContains(t, rs.texts(), "/repo| secret:hunter2")
		assert.Contains(t, rs.texts(), "/repo| escaped secret:of mine")
		assert.Empty(t, rs.scrubbed()) // withheld at record, nothing later scrubs
	})

	t.Run("refused_submit_records_nothing", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		f.Refuse(ctl.MethodSubmit, ctl.CodeBusy, "prompt queue is full")
		require.Error(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "never landed", PendingID: "c1"}))
		assert.Empty(t, rs.texts())
	})

	t.Run("scheduler_path_records_nothing", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.Submit(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "scheduled prompt", PendingID: "run-1"}))
		assert.Empty(t, rs.texts())
	})
}

func TestRecallLedger(t *testing.T) {
	t.Run("normal_commit_resolves", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "queued prompt", PendingID: "c1"}))
		promptCommit(t, f, "01LR1", false, "c1")
		waitForCommit(t, m, f.SessionID(), "01LR1")

		// a later redacted sighting must not withhold a settled row
		f.Broadcast(ctl.EventQueued, ctl.QueuedData{Rows: []ctl.QueueRow{{ID: "c1"}}})
		require.Eventually(t, func() bool {
			snap, err := m.Snapshot(t.Context(), f.SessionID())
			return err == nil && len(snap.QueuedRows) == 1
		}, 2*time.Second, testPoll)
		assert.Empty(t, rs.scrubbed())
		assert.Contains(t, rs.texts(), "/repo|queued prompt")
	})

	t.Run("injected_commit_withholds", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "odd landing", PendingID: "c1"}))
		promptCommit(t, f, "01LR2", true, "c1")

		require.Eventually(t, func() bool { return len(rs.scrubbed()) == 1 },
			2*time.Second, testPoll)
		assert.Contains(t, rs.texts(), "/repo|")
	})

	t.Run("redacted_queue_row_withholds", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "turned secret", PendingID: "c1"}))
		f.Broadcast(ctl.EventQueued, ctl.QueuedData{Rows: []ctl.QueueRow{{ID: "c1"}}})

		require.Eventually(t, func() bool { return len(rs.scrubbed()) == 1 },
			2*time.Second, testPoll)
		assert.Contains(t, rs.texts(), "/repo|")
	})

	t.Run("drop_is_absence_not_redaction", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "interrupted", PendingID: "c1"}))
		f.Broadcast(ctl.EventQueued,
			ctl.QueuedData{Rows: []ctl.QueueRow{{ID: "c1", Text: "interrupted"}}})
		// a drop means the prompt never commits, not that its text was
		// refused, upstream keeps dropped prompts recallable too
		f.Broadcast(ctl.EventQueueDropped, ctl.QueueDroppedData{
			Rows: []ctl.QueueRow{{ID: "c1"}}, Cause: "interrupt"})

		require.Eventually(t, func() bool { // the drop event reached the actor
			snap, err := m.Snapshot(t.Context(), f.SessionID())
			return err == nil && snap.Queued == 0
		}, 2*time.Second, testPoll)
		assert.Empty(t, rs.scrubbed())
		assert.Contains(t, rs.texts(), "/repo|interrupted")
	})

	t.Run("backfill_resolves_after_reconnect", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "dropped mid-flight", PendingID: "c1"}))

		// the commit rides the transcript a reconnect backfills, no live
		// entry.append announces it again
		f.DropConns()
		data, err := json.Marshal(session.MessageData{
			Message:  llm.Text(llm.RoleUser, "typed body"),
			QueueIDs: []string{"c1"},
		})
		require.NoError(t, err)
		f.WriteTranscript(t, fleettest.Entry{
			ID: "01LR3", Type: session.TypeMessage, TS: 100, Data: data})
		waitForState(t, m, f.SessionID(), ChildOnline)
		waitForCommit(t, m, f.SessionID(), "01LR3")
		assert.Empty(t, rs.scrubbed())
	})

	t.Run("backfill_redaction_withholds", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "secret while queued", PendingID: "c1"}))

		// the reconnect's snapshot carries the row redacted, and the backfill
		// resolves it before any live event could
		f.SetSnapshot(ctl.State{Workspace: "/repo",
			QueuedRows: []ctl.QueueRow{{ID: "c1"}}})
		f.DropConns()
		waitForState(t, m, f.SessionID(), ChildOnline) // backfill runs during prepare
		require.Eventually(t, func() bool { return len(rs.scrubbed()) == 1 },
			2*time.Second, testPoll)
	})
}

func TestRecallLinesListing(t *testing.T) {
	t.Run("serves_the_session_workspace", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "listed prompt", PendingID: "c1"}))

		rows, err := m.RecallLines(t.Context(), f.SessionID(), "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, "listed prompt", rows[0].Text)
	})

	t.Run("unknown_session_refused", func(t *testing.T) {
		m, _ := recallFleet(t, newFakeRecallStore())
		_, err := m.RecallLines(t.Context(), "01NOBODY00000000", "", 10)
		require.ErrorIs(t, err, ErrUnknownSession)
	})

	t.Run("no_store_reads_empty", func(t *testing.T) {
		m, home := newTestFleet(t, nil)
		f := fleettest.New(t, home, fleettest.Options{SessionID: "01NOSTORE00000000"})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		rows, err := m.RecallLines(t.Context(), f.SessionID(), "", 10)
		require.NoError(t, err)
		assert.NotNil(t, rows)
		assert.Empty(t, rows)
	})
}

// appendTypedLine records one CLI-typed line in workspace's editor history,
// where an interactive ajent run persists its recall source.
func appendTypedLine(t *testing.T, ws, text string) {
	t.Helper()
	store, err := session.NewStore()
	require.NoError(t, err)
	hist, err := session.NewEditorHistory(store, ws, recallSecretPrefix)
	require.NoError(t, err)
	hist.Append(text)
}

// recordPromptTranscript saves one user prompt in workspace's session store,
// the transcript source an interactive CLI's Ctrl+R backfills from.
func recordPromptTranscript(t *testing.T, ws, text string) {
	t.Helper()
	store, err := session.NewStore()
	require.NoError(t, err)
	w, err := store.Create(ws, session.SessionData{Version: session.Version(), Workspace: ws})
	require.NoError(t, err)
	t.Cleanup(func() { _ = w.Close() })
	_, err = w.Append(session.TypeMessage, session.MessageData{
		Message: llm.Text(llm.RoleUser, text)})
	require.NoError(t, err)
}

func recallTexts(rows []RecallLine) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Text
	}
	return out
}

// The listing merges ajent's own recall store with the mirror. IsolateHome
// pins AJENT_HOME, so helpers writing through session.NewStore land where the
// manager reads.
func TestRecallLinesAjentSources(t *testing.T) {
	t.Run("serves_cli_typed_lines", func(t *testing.T) {
		m, f := recallFleet(t, newFakeRecallStore())
		appendTypedLine(t, "/repo", "typed in the cli")
		appendTypedLine(t, "/repo", "secret:hunter2")

		rows, err := m.RecallLines(t.Context(), f.SessionID(), "", 10)
		require.NoError(t, err)
		texts := recallTexts(rows)
		assert.Contains(t, texts, "typed in the cli")
		assert.NotContains(t, texts, "secret:hunter2") // upstream's own rule hides it
	})

	t.Run("backfills_recorded_prompts", func(t *testing.T) {
		m, f := recallFleet(t, newFakeRecallStore())
		recordPromptTranscript(t, "/repo", "prompt from an older transcript")

		rows, err := m.RecallLines(t.Context(), f.SessionID(), "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, "prompt from an older transcript", rows[0].Text)
		// the committed entry's stamp rides through as the record time
		assert.WithinDuration(t, time.Now().UTC(), rows[0].CreatedAt, time.Minute)
	})

	t.Run("typed_line_joins_recorded_time", func(t *testing.T) {
		m, f := recallFleet(t, newFakeRecallStore())
		recordPromptTranscript(t, "/repo", "shared text")
		appendTypedLine(t, "/repo", "shared text")

		rows, err := m.RecallLines(t.Context(), f.SessionID(), "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.False(t, rows[0].CreatedAt.IsZero()) // the transcript's stamp wins over zero
	})

	t.Run("mirror_row_dedupes", func(t *testing.T) {
		rs := newFakeRecallStore()
		m, f := recallFleet(t, rs)
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "from the web", PendingID: "c1"}))
		appendTypedLine(t, "/repo", "from the web") // upstream's serve driver records it too

		rows, err := m.RecallLines(t.Context(), f.SessionID(), "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, "from the web", rows[0].Text)
		assert.False(t, rows[0].CreatedAt.IsZero()) // the mirror's record time outranks zero
		assert.NotZero(t, rows[0].ID)               // and the mirror id survives the merge
	})

	t.Run("query_narrows_all_sources", func(t *testing.T) {
		m, f := recallFleet(t, newFakeRecallStore())
		require.NoError(t, m.SubmitTracked(t.Context(), f.SessionID(),
			ctl.SubmitParams{Line: "web filler prompt", PendingID: "c1"}))
		appendTypedLine(t, "/repo", "cli SEARCH target")

		rows, err := m.RecallLines(t.Context(), f.SessionID(), "search", 10)
		require.NoError(t, err)
		assert.Equal(t, []string{"cli SEARCH target"}, recallTexts(rows))
	})
}

func TestMergeRecallLines(t *testing.T) {
	early := time.UnixMilli(1000).UTC()
	late := time.UnixMilli(2000).UTC()

	t.Run("keeps_newest_per_text", func(t *testing.T) {
		mirror := []RecallLine{{ID: 7, Text: "dup", CreatedAt: early}}
		ajent := []RecallLine{{Text: "dup", CreatedAt: late}, {Text: "only ajent"}}

		out := mergeRecallLines(mirror, ajent)
		require.Len(t, out, 2)
		assert.Contains(t, out, RecallLine{Text: "dup", CreatedAt: late})
		assert.Contains(t, out, RecallLine{Text: "only ajent"})
	})

	t.Run("mirror_wins_ties", func(t *testing.T) {
		mirror := []RecallLine{{ID: 7, Text: "same", CreatedAt: early}}
		ajent := []RecallLine{{Text: "same", CreatedAt: early}}

		out := mergeRecallLines(mirror, ajent)
		require.Len(t, out, 1)
		assert.Equal(t, int64(7), out[0].ID)
	})

	t.Run("drops_empty_texts", func(t *testing.T) {
		mirror := []RecallLine{{ID: 9}} // a withheld row
		ajent := []RecallLine{{Text: ""}, {Text: "kept", CreatedAt: early}}

		out := mergeRecallLines(mirror, ajent)
		assert.Equal(t, []RecallLine{{Text: "kept", CreatedAt: early}}, out)
	})
}
