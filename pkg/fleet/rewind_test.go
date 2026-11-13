package fleet

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mustEntry marshals one payload into an entry, failing the test on the
// unreachable encode error.
func mustEntry(t *testing.T, id, parent string, typ session.Type, data any) session.Entry {
	t.Helper()
	raw, err := json.Marshal(data)
	require.NoError(t, err)
	return session.Entry{ID: id, ParentID: parent, Type: typ, TS: 100, Data: raw}
}

// prompt builds one user-prompt message entry.
func prompt(t *testing.T, id, parent, text string) session.Entry {
	t.Helper()
	return mustEntry(t, id, parent, session.TypeMessage,
		session.MessageData{Message: llm.Text(llm.RoleUser, text)})
}
func TestRewind(t *testing.T) {
	t.Parallel()

	t.Run("candidates", func(t *testing.T) {
		cases := []struct {
			name    string
			entries []session.Entry
			head    string
			wantIDs []string // nil asserts no candidates at all
			wantKds map[string]string
			isHead  string
		}{
			{
				name: "empty_tree_yields_none",
			},
			{
				name: "prompts_resend_assistants_keep",
				entries: []session.Entry{
					prompt(t, "u1", "", "hello"),
					mustEntry(t, "a2", "u1", session.TypeMessage,
						session.MessageData{Message: llm.Text(llm.RoleAssistant, "hi there")}),
				},
				wantIDs: []string{"u1", "a2"},
				wantKds: map[string]string{"u1": CandidateUser, "a2": CandidateAssistant},
			},
			{
				name: "tool_result_carriers_stay_out",
				entries: []session.Entry{mustEntry(t, "r1", "", session.TypeMessage,
					session.MessageData{Message: llm.Message{Role: llm.RoleUser, Content: llm.BlockList{
						llm.ToolResultBlock{CallID: "c1"},
					}}})},
			},
			{
				name: "injected_context_stays_out",
				entries: []session.Entry{mustEntry(t, "i1", "", session.TypeMessage,
					session.MessageData{Injected: true, Message: llm.Text(llm.RoleUser, "context")})},
			},
			{
				name: "compaction_targets_allowed",
				entries: []session.Entry{
					mustEntry(t, "c1", "", session.TypeCompaction, session.CompactionData{Summary: "early context"}),
				},
				wantIDs: []string{"c1"},
				wantKds: map[string]string{"c1": CandidateCompaction},
			},
			{
				name: "other_types_refused_upstream",
				entries: []session.Entry{
					mustEntry(t, "n1", "", session.TypeNotice, session.NoticeData{Message: "n"}),
					{ID: "s0", Type: session.TypeSession},
				},
			},
			{
				name: "current_head_is_marked",
				entries: []session.Entry{
					prompt(t, "u1", "", "hello"),
					mustEntry(t, "a2", "u1", session.TypeMessage,
						session.MessageData{Message: llm.Text(llm.RoleAssistant, "hi there")}),
				},
				head:    "a2",
				wantIDs: []string{"u1", "a2"},
				wantKds: map[string]string{"u1": CandidateUser, "a2": CandidateAssistant},
				isHead:  "a2",
			},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				res := rewindCandidates(tc.entries, tc.head)
				assert.Equal(t, tc.head, res.Head)

				gotIDs := make([]string, 0, len(res.Candidates))
				for _, c := range res.Candidates {
					gotIDs = append(gotIDs, c.ID)
					assert.Equal(t, tc.wantKds[c.ID], c.Kind)
				}
				if tc.wantIDs == nil {
					assert.Empty(t, gotIDs)
				} else {
					assert.Equal(t, tc.wantIDs, gotIDs)
				}
				for _, c := range res.Candidates {
					assert.Equal(t, c.ID == tc.isHead, c.IsHead)
				}
			})
		}
	})

	t.Run("candidate_labels", func(t *testing.T) {
		t.Run("labels_truncate_ellipsis", func(t *testing.T) {
			long := strings.Repeat("x", candidateLabelMax+50)
			res := rewindCandidates([]session.Entry{prompt(t, "u1", "", long)}, "")
			require.Len(t, res.Candidates, 1)

			label := res.Candidates[0].Label
			assert.Equal(t, candidateLabelMax, utf8.RuneCountInString(label)) // cap includes the ellipsis
			assert.True(t, strings.HasSuffix(label, "…"))
		})

		t.Run("labels_trim_their_whitespace", func(t *testing.T) {
			res := rewindCandidates([]session.Entry{prompt(t, "u1", "", "  padded\nlines  ")}, "")
			require.Len(t, res.Candidates, 1)
			assert.Equal(t, "padded\nlines", res.Candidates[0].Label)
		})
	})

	t.Run("tree_placement", func(t *testing.T) {
		// one trunk turn plus an abandoned fork: the second prompt branches off u1
		entries := []session.Entry{
			prompt(t, "u1", "", "first"),
			mustEntry(t, "a2", "u1", session.TypeMessage,
				session.MessageData{Message: llm.Text(llm.RoleAssistant, "reply")}),
			prompt(t, "u3", "u1", "forked"),
		}
		res := rewindCandidates(entries, "a2") // the trunk reply is live
		require.Len(t, res.Candidates, 3)

		byID := make(map[string]RewindCandidate, len(res.Candidates))
		for _, c := range res.Candidates {
			byID[c.ID] = c
		}
		assert.Equal(t, 0, byID["u1"].Depth) // the trunk stays flat
		assert.Equal(t, 1, byID["a2"].Depth) // every branch of a fork indents
		assert.Equal(t, 1, byID["u3"].Depth)
		assert.True(t, byID["a2"].Active)  // the live head's chain marks itself
		assert.False(t, byID["u3"].Active) // abandoned forks read as inactive
		assert.Equal(t, "├── ", byID["a2"].Guide)
	})

	t.Run("candidate_text", func(t *testing.T) {
		t.Run("user_prompts_carry_full_text", func(t *testing.T) {
			res := rewindCandidates([]session.Entry{prompt(t, "u1", "", "  the whole prompt ")}, "")
			require.Len(t, res.Candidates, 1)
			assert.Equal(t, "  the whole prompt ", res.Candidates[0].Text)
			assert.False(t, res.Candidates[0].Truncated)
		})

		t.Run("oversized_text_flagged", func(t *testing.T) {
			res := rewindCandidates([]session.Entry{
				prompt(t, "u1", "", strings.Repeat("x", rewindTextMax+10)),
			}, "")
			require.Len(t, res.Candidates, 1)
			assert.Len(t, []rune(res.Candidates[0].Text), rewindTextMax)
			assert.True(t, res.Candidates[0].Truncated)
		})

		t.Run("assistant_rows_carry_no_text", func(t *testing.T) {
			res := rewindCandidates([]session.Entry{
				mustEntry(t, "a1", "", session.TypeMessage,
					session.MessageData{Message: llm.Text(llm.RoleAssistant, "reply")}),
			}, "")
			require.Len(t, res.Candidates, 1)
			assert.Empty(t, res.Candidates[0].Text)
		})
	})
}
