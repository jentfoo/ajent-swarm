package fleet

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent/pkg/session"
)

// ent builds one transcript entry for tip and paging tests.
func ent(id, parent string, ts int64) session.Entry {
	return session.Entry{ID: id, ParentID: parent, Type: session.TypeMessage, TS: ts}
}
func TestTranscript(t *testing.T) {
	t.Run("recorded tip", func(t *testing.T) {
		tests := []struct {
			name    string
			entries []session.Entry
			want    string
		}{
			{"empty", nil, ""},
			{"clean_chain", []session.Entry{
				ent("a", "", 1), ent("b", "a", 2), ent("c", "b", 3),
			}, "c"},
			{"rewind_abandoned_fork", []session.Entry{
				ent("a", "", 1), ent("b", "a", 2),
				ent("fork", "b", 3), // abandoned by a rewind, its leaf ages on
				ent("live", "b", 9), // the branch that kept appending
			}, "live"},
			{"newest_leaf_of_many", []session.Entry{
				ent("root", "", 1),
				ent("f1", "root", 5), ent("f2", "root", 7), ent("main", "root", 6),
			}, "f2"},
			{"tie_breaks_by_id", []session.Entry{
				ent("root", "", 1),
				ent("01AAA", "root", 5), ent("01BBB", "root", 5),
			}, "01BBB"},
			{"cycle_falls_back_to_tail", []session.Entry{
				ent("a", "b", 1), ent("b", "a", 2),
			}, "b"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				assert.Equal(t, tt.want, recordedTip(tt.entries))
			})
		}
	})

	t.Run("recorded tip over written file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "transcript.jsonl")
		now := time.Now().UnixMilli()
		rows := []session.Entry{
			ent("a", "", now), ent("b", "a", now+1),
			ent("fork", "b", now+2), // abandoned by a rewind, its leaf ages on
			ent("live", "b", now+8), // the branch that kept appending
		}

		t.Run("empty file yields no branch", func(t *testing.T) {
			require.NoError(t, os.WriteFile(path, nil, 0o600))
			entries, _, err := session.Read(path)
			require.NoError(t, err)
			assert.Empty(t, recordedTip(entries))
		})

		t.Run("fork loses to newer leaf", func(t *testing.T) {
			writeTranscriptFixture(t, path, rows...)
			entries, _, err := session.Read(path)
			require.NoError(t, err)
			assert.Equal(t, "live", recordedTip(entries))
		})

		t.Run("torn tail skipped", func(t *testing.T) {
			writeTranscriptFixture(t, path, rows...)
			f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
			require.NoError(t, err)
			_, err = f.WriteString(`{"id":"torn"`) // no trailing newline
			require.NoError(t, err)
			_ = f.Close()
			entries, _, err := session.Read(path)
			require.NoError(t, err)
			require.Len(t, entries, 4)
			assert.Equal(t, "live", recordedTip(entries))
		})
	})

	t.Run("page branch", func(t *testing.T) {
		branch := chain(5)
		tests := []struct {
			name       string
			before     string
			limit      int
			wantIDs    []string
			wantCursor string
		}{
			{"newest_window", "", 3, []string{"e2", "e3", "e4"}, "e2"},
			{"before_cursor", "e2", 2, []string{"e0", "e1"}, ""},
			{"whole_history", "", 100, []string{"e0", "e1", "e2", "e3", "e4"}, ""},
			{"limit_clamps_to_one", "e4", 0, []string{"e3"}, "e3"},
			{"unknown_cursor", "nope", 3, []string{}, ""},
			{"older_than_head", "e4", 2, []string{"e2", "e3"}, "e2"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				page, cursor := pageBranch(branch, tt.before, tt.limit)
				got := make([]string, 0, len(page))
				for _, e := range page {
					got = append(got, e.ID)
				}
				assert.Equal(t, tt.wantIDs, got)
				assert.Equal(t, tt.wantCursor, cursor)
			})
		}
	})

	t.Run("page branch bytes bound", func(t *testing.T) {
		huge := ent("huge", "e1", 3)
		huge.Data = json.RawMessage(`"` + strings.Repeat("x", initMaxBytes+1) + `"`)
		branch := append(chain(2), huge) // the walk starts at the newest entry

		page, cursor := pageBranch(branch, "", 10)
		require.Len(t, page, 1) // the big entry fills the byte budget alone
		assert.Equal(t, "huge", page[0].ID)
		assert.Equal(t, "huge", cursor)
	})

	t.Run("find saved row", func(t *testing.T) {
		rows := []session.Listed{
			{Info: session.Info{Path: "/w1/alpha", ID: "01AAAA", Name: "alpha"}, Workspace: "/w1"},
			{Info: session.Info{Path: "/w2/shared", ID: "01AABB", Name: "shared"}, Workspace: "/w2"},
			{Info: session.Info{Path: "/w3/plain", ID: "01CCCC"}, Workspace: "/w3"},
			{Info: session.Info{Path: "/w4/shared", ID: "01DDDD", Name: "shared"}, Workspace: "/w4"},
		}
		tests := []struct {
			name      string
			target    string
			wantPath  string
			wantError error
		}{
			{"exact_id", "01CCCC", "/w3/plain", nil},
			{"unique_prefix", "01AAB", "/w2/shared", nil},
			{"name_case_insensitive", "ALPHA", "/w1/alpha", nil},
			{"ambiguous_name", "shared", "", ErrAmbiguousSaved},
			{"miss", "zzz", "", errNoSavedMatch},
			{"two_prefixes_no_name", "01AA", "", errNoSavedMatch}, // prefix ambiguity yields to names, none match
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				row, err := findSavedRow(rows, tt.target)
				if tt.wantError != nil {
					require.ErrorIs(t, err, tt.wantError)
					return
				}
				require.NoError(t, err)
				assert.Equal(t, tt.wantPath, row.Path)
			})
		}
	})
}

func writeTranscriptFixture(t *testing.T, path string, entries ...session.Entry) {
	t.Helper()
	var buf []byte
	for _, e := range entries {
		line, err := json.Marshal(e)
		require.NoError(t, err)
		buf = append(buf, line...)
		buf = append(buf, '\n')
	}
	require.NoError(t, os.WriteFile(path, buf, 0o600))
}

func chain(n int) []session.Entry {
	out := make([]session.Entry, 0, n)
	for i := range n {
		parent := ""
		if i > 0 {
			parent = "e" + strconv.Itoa(i-1)
		}
		out = append(out, ent("e"+strconv.Itoa(i), parent, int64(100+i)))
	}
	return out
}
