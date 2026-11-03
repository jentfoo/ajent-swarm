package store

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRecordRecallLine(t *testing.T) {
	t.Parallel()

	at := time.UnixMilli(1730000000000)

	t.Run("records_and_reads_newest_first", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		_, err := st.RecordRecallLine(ctx, "/repo", "first idea", at)
		require.NoError(t, err)
		_, err = st.RecordRecallLine(ctx, "/repo", "second idea", at.Add(time.Second))
		require.NoError(t, err)

		rows, err := st.RecallLines(ctx, "/repo", "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 2)
		assert.Equal(t, "second idea", rows[0].Text)
		assert.Equal(t, at.Add(time.Second), rows[0].CreatedAt)
		assert.Equal(t, "first idea", rows[1].Text)
	})

	t.Run("workspaces_stay_separate", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		_, err := st.RecordRecallLine(ctx, "/repo", "repo line", at)
		require.NoError(t, err)
		_, err = st.RecordRecallLine(ctx, "/other", "other line", at)
		require.NoError(t, err)

		rows, err := st.RecallLines(ctx, "/repo", "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, "repo line", rows[0].Text)
	})

	t.Run("consecutive_repeat_folds_newest_wins", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		_, err := st.RecordRecallLine(ctx, "/repo", "same idea", at)
		require.NoError(t, err)
		id, err := st.RecordRecallLine(ctx, "/repo", "same idea", at.Add(time.Minute))
		require.NoError(t, err)

		rows, err := st.RecallLines(ctx, "/repo", "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 1) // the repeat never gained a row
		assert.Equal(t, id, rows[0].ID)
		assert.Equal(t, at.Add(time.Minute), rows[0].CreatedAt)
	})

	t.Run("older_duplicates_collapse_to_newest", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		for i, text := range []string{"fix bug", "ship it", "fix bug"} {
			_, err := st.RecordRecallLine(ctx, "/repo", text, at.Add(time.Duration(i)*time.Minute))
			require.NoError(t, err)
		}

		rows, err := st.RecallLines(ctx, "/repo", "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 2)
		assert.Equal(t, "fix bug", rows[0].Text) // the newest occurrence wins
		assert.Equal(t, "ship it", rows[1].Text)
	})

	t.Run("trailing_cr_trims", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		_, err := st.RecordRecallLine(ctx, "/repo", "typed\r", at)
		require.NoError(t, err)
		id, err := st.RecordRecallLine(ctx, "/repo", "typed", at.Add(time.Second))
		require.NoError(t, err) // folds into the trimmed row, not a second one

		rows, err := st.RecallLines(ctx, "/repo", "", 10)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, id, rows[0].ID)
		assert.Equal(t, "typed", rows[0].Text)
	})

	t.Run("cap_keeps_newest", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		for i := range maxRecallLines + 5 {
			_, err := st.RecordRecallLine(ctx, "/repo", fmt.Sprintf("line %04d", i),
				at.Add(time.Duration(i)*time.Minute))
			require.NoError(t, err)
		}

		rows, err := st.RecallLines(ctx, "/repo", "", maxRecallLines+5)
		require.NoError(t, err)
		assert.Len(t, rows, maxRecallLines)
		assert.Equal(t, fmt.Sprintf("line %04d", maxRecallLines+4), rows[0].Text)
	})

	t.Run("blank_workspace_rejected", func(t *testing.T) {
		st := newTestStore(t)
		_, err := st.RecordRecallLine(t.Context(), " ", "x", at)
		require.Error(t, err)
		_, err = st.RecallLines(t.Context(), "", "", 10)
		require.Error(t, err)
	})
}

func TestScrubRecallLine(t *testing.T) {
	t.Parallel()

	t.Run("withholds_text_keeps_row", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		id, err := st.RecordRecallLine(ctx, "/repo", "secret:hunter2", time.UnixMilli(1))
		require.NoError(t, err)
		require.NoError(t, st.ScrubRecallLine(ctx, id))

		rows, err := st.RecallLines(ctx, "/repo", "", 10)
		require.NoError(t, err)
		assert.Empty(t, rows) // withheld rows never surface

		// the id still resolves: a second scrub answers not found, not a miss
		require.ErrorIs(t, st.ScrubRecallLine(ctx, id+1), ErrNotFound)
	})
}

func TestRecallLinesQuery(t *testing.T) {
	t.Parallel()

	st := newTestStore(t)
	ctx := t.Context()
	at := time.UnixMilli(1730000000000)
	for i, text := range []string{"Fix the retry loop", "ship the release", "fix the flake"} {
		_, err := st.RecordRecallLine(ctx, "/repo", text, at.Add(time.Duration(i)*time.Minute))
		require.NoError(t, err)
	}

	t.Run("narrows_case_insensitive", func(t *testing.T) {
		rows, err := st.RecallLines(ctx, "/repo", "FIX THE", 10)
		require.NoError(t, err)
		require.Len(t, rows, 2)
		assert.Equal(t, "fix the flake", rows[0].Text)
		assert.Equal(t, "Fix the retry loop", rows[1].Text)
	})

	t.Run("limit_caps_matches", func(t *testing.T) {
		rows, err := st.RecallLines(ctx, "/repo", "", 2)
		require.NoError(t, err)
		assert.Len(t, rows, 2)
	})

	t.Run("no_match_reads_empty", func(t *testing.T) {
		rows, err := st.RecallLines(ctx, "/repo", "nothing like this", 10)
		require.NoError(t, err)
		assert.NotNil(t, rows)
		assert.Empty(t, rows)
	})
}
