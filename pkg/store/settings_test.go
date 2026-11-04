package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Swarm-level settings round trip through the app_settings table: set, read,
// overwrite and clear.
func TestSettingsRoundTrip(t *testing.T) {
	t.Parallel()
	st, err := Open(filepath.Join(t.TempDir(), "swarm.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()

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
