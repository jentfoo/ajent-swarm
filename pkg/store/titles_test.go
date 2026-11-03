package store

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSetSessionTitle(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	require.NoError(t, st.SetSessionTitle(t.Context(), "01A", "fix login flow"))

	titles, err := st.SessionTitles(t.Context())
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"01A": "fix login flow"}, titles)
}

func TestSetSessionTitleUpsertAndClear(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)
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
}

func TestSetSessionTitleClipsLongInput(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	long := strings.Repeat("x", maxTitleRunes+50)
	require.NoError(t, st.SetSessionTitle(t.Context(), "01A", long))

	titles, err := st.SessionTitles(t.Context())
	require.NoError(t, err)
	assert.Len(t, titles["01A"], maxTitleRunes)
}

func TestSetSessionTitleRequiresID(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	err := st.SetSessionTitle(t.Context(), "  ", "title")
	require.Error(t, err)

	titles, err := st.SessionTitles(t.Context())
	require.NoError(t, err)
	assert.Empty(t, titles)
}

func TestSessionTitlesEmpty(t *testing.T) {
	t.Parallel()
	st := openTestStore(t)

	titles, err := st.SessionTitles(t.Context())
	require.NoError(t, err)
	assert.Empty(t, titles)
}

// openTestStore opens one store over a throwaway database file.
func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir() + "/" + FileName)
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })
	return st
}
