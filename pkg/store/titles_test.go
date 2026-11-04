package store

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSessionTitles(t *testing.T) {
	t.Parallel()

	t.Run("set and get", func(t *testing.T) {
		st := newTestStore(t)

		require.NoError(t, st.SetSessionTitle(t.Context(), "01A", "fix login flow"))

		titles, err := st.SessionTitles(t.Context())
		require.NoError(t, err)
		assert.Equal(t, map[string]string{"01A": "fix login flow"}, titles)
	})

	t.Run("upsert and clear", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()

		require.NoError(t, st.SetSessionTitle(ctx, "01A", "first"))
		require.NoError(t, st.SetSessionTitle(ctx, "01A", "second"))
		titles, err := st.SessionTitles(ctx)
		require.NoError(t, err)
		assert.Equal(t, map[string]string{"01A": "second"}, titles)

		// whitespace-only clears the row instead of storing blank labels
		require.NoError(t, st.SetSessionTitle(ctx, "01A", "   "))
		titles, err = st.SessionTitles(ctx)
		require.NoError(t, err)
		assert.Empty(t, titles)
	})

	t.Run("clips long input", func(t *testing.T) {
		st := newTestStore(t)

		long := strings.Repeat("x", maxTitleRunes+50)
		require.NoError(t, st.SetSessionTitle(t.Context(), "01A", long))

		titles, err := st.SessionTitles(t.Context())
		require.NoError(t, err)
		assert.Len(t, titles["01A"], maxTitleRunes)
	})

	t.Run("requires id", func(t *testing.T) {
		st := newTestStore(t)

		err := st.SetSessionTitle(t.Context(), "  ", "title")
		require.Error(t, err)

		titles, err := st.SessionTitles(t.Context())
		require.NoError(t, err)
		assert.Empty(t, titles)
	})
}
