package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSettings(t *testing.T) {
	t.Parallel()

	t.Run("missing_key_reads_empty", func(t *testing.T) {
		st := newTestStore(t)
		value, err := st.Setting(t.Context(), "title_model")
		require.NoError(t, err)
		assert.Empty(t, value)
	})

	t.Run("trims_on_write", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		require.NoError(t, st.SetSetting(ctx, "title_model", " m1 "))
		value, err := st.Setting(ctx, "title_model")
		require.NoError(t, err)
		assert.Equal(t, "m1", value)
	})

	t.Run("upsert_overwrites", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		require.NoError(t, st.SetSetting(ctx, "title_model", "m1"))
		require.NoError(t, st.SetSetting(ctx, "title_model", "m2"))
		value, err := st.Setting(ctx, "title_model")
		require.NoError(t, err)
		assert.Equal(t, "m2", value)
	})

	t.Run("empty_clears", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		require.NoError(t, st.SetSetting(ctx, "title_model", "m1"))
		require.NoError(t, st.SetSetting(ctx, "title_model", ""))
		value, err := st.Setting(ctx, "title_model")
		require.NoError(t, err)
		assert.Empty(t, value)
	})

	t.Run("blank_key_rejected", func(t *testing.T) {
		st := newTestStore(t)
		ctx := t.Context()
		require.Error(t, st.SetSetting(ctx, " ", "x"))
		_, err := st.Setting(ctx, " ")
		assert.Error(t, err)
	})
}
