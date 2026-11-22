package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChains(t *testing.T) {
	t.Parallel()

	t.Run("upsert_replaces_one_row", func(t *testing.T) {
		t.Parallel()
		st := newTestStore(t)
		ctx := t.Context()

		ch := Chain{
			ID: "chn_1", ParentID: "01P", ChildID: "01C", FinalPrompt: "wrap up",
			ChildPrompt: "continue", PendingID: "pd1",
			State: "waiting", Mark: "01B1", FinalAt: 90, CreatedAt: 100, UpdatedAt: 100,
		}
		require.NoError(t, st.SaveChain(ctx, ch))
		ch.State = "failed"
		ch.Reason = "child exited"
		ch.Mark = "" // an edit back to waiting clears the bound entry and submit
		ch.FinalAt = 0
		ch.UpdatedAt = 200
		require.NoError(t, st.SaveChain(ctx, ch))

		rows, err := st.LoadChains(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		// every column round-trips, restart recovery reads them all
		assert.Equal(t, ch, rows[0])
	})

	t.Run("load_orders_oldest_first", func(t *testing.T) {
		t.Parallel()
		st := newTestStore(t)
		ctx := t.Context()

		for i, at := range []int64{300, 100, 200} {
			require.NoError(t, st.SaveChain(ctx, Chain{
				ID: string(rune('a' + i)), CreatedAt: at, UpdatedAt: at,
				State: "waiting",
			}))
		}
		rows, err := st.LoadChains(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 3)
		assert.Equal(t, []string{"b", "c", "a"},
			[]string{rows[0].ID, rows[1].ID, rows[2].ID})
	})

	t.Run("delete_removes_only_the_named_row", func(t *testing.T) {
		t.Parallel()
		st := newTestStore(t)
		ctx := t.Context()

		for _, id := range []string{"chn_1", "chn_2"} {
			require.NoError(t, st.SaveChain(ctx, Chain{ID: id, State: "waiting"}))
		}
		require.NoError(t, st.DeleteChain(ctx, "chn_1"))
		require.NoError(t, st.DeleteChain(ctx, "chn_gone")) // unknown ids stay clean

		rows, err := st.LoadChains(ctx)
		require.NoError(t, err)
		require.Len(t, rows, 1)
		assert.Equal(t, []string{"chn_2"}, []string{rows[0].ID})
	})
}
