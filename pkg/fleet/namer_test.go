package fleet

import (
	"bytes"
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

func TestNamer(t *testing.T) {
	t.Run("sanitize_session_title", func(t *testing.T) {
		cases := []struct {
			name string
			in   string
			want string
		}{
			{"plain_one_line", "Fix the login flow", "Fix the login flow"},
			{"padded_spaces_collapse", "  padded   spaces  collapse ", "padded spaces collapse"},
			{"first_line_wins", "first line only\nsecond line dropped", "first line only"},
			{"blank_output", "\n", ""},
			{"empty_output", "", ""},
			{"tool_call_then_title",
				"<tool_call>\n{\"name\": \"agent_start\"}\n</tool_call>\nFix the login flow", "Fix the login flow"},
			{"interleaved_tags_skip_to_last",
				"first try\n<arg_key>\nsecond try\n</tool_call>\nreal title", "real title"},
			{"markup_only", "<tool_call>\n{\"name\": \"read\"}\n</tool_call>\n", ""},
			{"blank_lines_after_tag_skipped", "</tool_call>\n\n   \nFix the login flow", "Fix the login flow"},
			{"indented_closing_tag", "\t </tool_call>  \nFix the login flow", "Fix the login flow"},
			{"brackets_with_spaces_are_content", "<invoke some tool>", "<invoke some tool>"},
			{"markup_inside_prose_kept", "Fix <div> layout now", "Fix <div> layout now"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				assert.Equal(t, tc.want, sanitizeSessionTitle(tc.in))
			})
		}
	})

	t.Run("titles_from_first_prompt", func(t *testing.T) {
		store := newTitleMemStore()
		owned := func(inst ctl.Instance) bool { return inst.SessionID == "01AUTOTITLE0000000" }
		bin, _ := fakeNamerBin(t)
		m, home := newTestFleetWithTitlesAndBin(t, store, bin, owned)

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

		// the labeler runs once over the first typed prompt recovered from the
		// transcript at attach and writes through swarm's own title store
		require.Eventually(t, func() bool {
			return store.snapshot()[f.SessionID()] == "Fix login flow"
		}, 2*time.Second, testPoll)

		// every surface sees the title, ajent's own session name stays clean
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
	})

	t.Run("adopted_session_auto_titles", func(t *testing.T) {
		t.Run("names_from_backfill", func(t *testing.T) {
			store := newTitleMemStore()
			bin, runs := fakeNamerBin(t)
			m, home := newTestFleetWithTitlesAndBin(t, store, bin, nil)

			f := fleettest.New(t, home, fleettest.Options{SessionID: "01ADOPTNAME000000001"})
			f.WriteTranscript(t, adoptedTranscript(true)...)
			f.WriteRegistry(t, os.Getpid(), time.Now())

			waitForState(t, m, f.SessionID(), ChildOnline)
			require.Eventually(t, func() bool {
				return store.snapshot()[f.SessionID()] == "Fix login flow"
			}, 2*time.Second, testPoll)

			rows := m.Sessions()
			require.Len(t, rows, 1)
			assert.Equal(t, "Fix login flow", rows[0].Title)
			assert.Equal(t, 1, runs())

			// a reconnect re-prepares through the same backfill without renaming
			dials := f.DialCount()
			f.DropConns()
			require.Eventually(t, func() bool { return f.DialCount() > dials }, 2*time.Second, testPoll)
			waitForState(t, m, f.SessionID(), ChildOnline)
			assert.Equal(t, 1, runs())

			for _, req := range f.Received() {
				if req.Method == ctl.MethodSubmit {
					t.Fatalf("namer submitted %q upstream; titles must never touch ajent names",
						string(req.Params))
				}
			}
		})

		t.Run("stored_title_skips_run", func(t *testing.T) {
			store := newTitleMemStore()
			bin, runs := fakeNamerBin(t)
			m, home := newTestFleetWithTitlesAndBin(t, store, bin, nil)

			f := fleettest.New(t, home, fleettest.Options{SessionID: "01ADOPTNAMED000000001"})
			f.WriteTranscript(t, adoptedTranscript(true)...)
			require.NoError(t, m.SetTitle(t.Context(), f.SessionID(), "human rename"))
			f.WriteRegistry(t, os.Getpid(), time.Now())

			waitForState(t, m, f.SessionID(), ChildOnline)

			rows := m.Sessions()
			require.Len(t, rows, 1)
			assert.Equal(t, "human rename", rows[0].Title) // the stored title wins
			require.Never(t, func() bool { return runs() > 0 }, 60*time.Millisecond, testPoll)
		})

		t.Run("no_prompt_waits_for_append", func(t *testing.T) {
			store := newTitleMemStore()
			bin, runs := fakeNamerBin(t)
			m, home := newTestFleetWithTitlesAndBin(t, store, bin, nil)

			f := fleettest.New(t, home, fleettest.Options{SessionID: "01ADOPTQUIET000000001"})
			entries := adoptedTranscript(false)
			f.WriteTranscript(t, entries...)
			f.WriteRegistry(t, os.Getpid(), time.Now())

			waitForState(t, m, f.SessionID(), ChildOnline)
			require.Never(t, func() bool { return runs() > 0 }, 60*time.Millisecond, testPoll)

			// the first typed prompt still names it through the live event path
			f.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: wireEntry(fleettest.Entry{
				ID:       "01ADOPTMSG0000000002",
				ParentID: entries[0].ID,
				Type:     session.TypeMessage,
				Data: mustJSON(session.MessageData{
					Message: llm.Text(llm.RoleUser, "fix the login flow"),
				}),
			})})

			require.Eventually(t, func() bool {
				return store.snapshot()[f.SessionID()] == "Fix login flow"
			}, 2*time.Second, testPoll)
			assert.Equal(t, 1, runs())
		})
	})

	t.Run("scratch_transcript_removed", func(t *testing.T) {
		testutil.IsolateHome(t)
		scratch := t.TempDir()

		store, err := session.NewStore()
		require.NoError(t, err)
		saved, err := store.Dir(scratch)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(
			filepath.Join(saved, "run.jsonl"), []byte("{}\n"), 0o600))

		removeScratchTranscript(scratch)

		_, statErr := os.Stat(saved)
		assert.True(t, os.IsNotExist(statErr))
	})

	t.Run("skipped_without_bin", func(t *testing.T) {
		store := newTitleMemStore()
		m, home := newTestFleetWithTitles(t, store)

		f := fleettest.New(t, home, fleettest.Options{SessionID: "01NOBINNAME000000"})
		f.WriteRegistry(t, os.Getpid(), time.Now())
		waitForState(t, m, f.SessionID(), ChildOnline)

		assert.Empty(t, store.snapshot()) // no configured binary, nothing to run
	})
}

func fakeNamerBin(t *testing.T) (string, func() int) {
	t.Helper()
	dir := t.TempDir()
	marker := filepath.Join(dir, "namer-runs")
	path := filepath.Join(dir, "ajent-fake")
	script := "#!/bin/sh\necho 'Fix login flow'\necho run >> " + marker + "\n"
	require.NoError(t, os.WriteFile(path, []byte(script), 0o700))
	return path, func() int {
		b, err := os.ReadFile(marker)
		if err != nil { // never ran
			return 0
		}
		return bytes.Count(b, []byte{'\n'})
	}
}

func adoptedTranscript(prompt bool) []fleettest.Entry {
	root := fleettest.Entry{
		ID:   "01ADOPTROOT0000000001",
		Type: session.TypeSession,
		Data: mustJSON(session.SessionData{Version: 1}),
	}
	out := []fleettest.Entry{root}
	if prompt {
		out = append(out, fleettest.Entry{
			ID:       "01ADOPTMSG0000000001",
			ParentID: root.ID,
			Type:     session.TypeMessage,
			Data: mustJSON(session.MessageData{
				Message: llm.Text(llm.RoleUser, "fix the login flow"),
			}),
		})
	}
	return out
}

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
	ctx, cancel := context.WithCancel(t.Context())
	m.Start(ctx)
	t.Cleanup(func() {
		cancel()
		m.Stop()
	})
	return m, home
}
