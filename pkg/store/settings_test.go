package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSettings(t *testing.T) {
	t.Parallel()

	st := newTestStore(t)
	ctx := t.Context()

	value, err := st.Setting(ctx, "title_model")
	require.NoError(t, err)
	assert.Empty(t, value) // missing keys read back empty

	require.NoError(t, st.SetSetting(ctx, "title_model", " m1 "))
	value, err = st.Setting(ctx, "title_model")
	require.NoError(t, err)
	assert.Equal(t, "m1", value) // trimmed on write

	require.NoError(t, st.SetSetting(ctx, "title_model", "m2"))
	value, err = st.Setting(ctx, "title_model")
	require.NoError(t, err)
	assert.Equal(t, "m2", value) // upsert overwrites

	require.NoError(t, st.SetSetting(ctx, "title_model", ""))
	value, err = st.Setting(ctx, "title_model")
	require.NoError(t, err)
	assert.Empty(t, value) // empty clears the row

	require.Error(t, st.SetSetting(ctx, " ", "x"))
	_, err = st.Setting(ctx, " ")
	assert.Error(t, err)
}
