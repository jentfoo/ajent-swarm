package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTokens(t *testing.T) {
	t.Parallel()

	t.Run("create_rejects_duplicates", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)
		tok := APIToken{Name: "ci", TokenHash: "hash-ci", CreatedAt: now}
		require.NoError(t, s.CreateAPIToken(ctx, tok))

		err := s.CreateAPIToken(ctx, tok)
		require.ErrorIs(t, err, ErrConflict)

		err = s.CreateAPIToken(ctx, APIToken{Name: "other", TokenHash: "hash-ci", CreatedAt: now})
		require.ErrorIs(t, err, ErrConflict)
	})

	t.Run("list_order", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)

		out, err := s.Tokens(ctx)
		require.NoError(t, err)
		assert.Empty(t, out)

		require.NoError(t, s.CreateAPIToken(ctx, APIToken{Name: "second", TokenHash: "hash-2", CreatedAt: now}))
		require.NoError(t, s.CreateAPIToken(ctx, APIToken{Name: "first", TokenHash: "hash-1", CreatedAt: now}))

		out, err = s.Tokens(ctx)
		require.NoError(t, err)
		require.Len(t, out, 2)
		assert.Equal(t, []string{"second", "first"}, []string{out[0].Name, out[1].Name})
		assert.Zero(t, out[0].LastUsed)
	})

	t.Run("lookup_by_hash", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)
		require.NoError(t, s.CreateAPIToken(ctx, APIToken{Name: "ci", TokenHash: "hash-ci", CreatedAt: now}))

		tok, err := s.APITokenByHash(ctx, "hash-ci")
		require.NoError(t, err)
		assert.Equal(t, "ci", tok.Name)

		_, err = s.APITokenByHash(ctx, "missing")
		require.ErrorIs(t, err, ErrNotFound)
	})

	t.Run("touch_usage", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)
		require.NoError(t, s.CreateAPIToken(ctx, APIToken{Name: "ci", TokenHash: "hash-ci", CreatedAt: now}))

		used := now.Add(time.Hour)
		require.NoError(t, s.TouchTokenUsage(ctx, "hash-ci", used))

		tok, err := s.APITokenByHash(ctx, "hash-ci")
		require.NoError(t, err)
		assert.Equal(t, used, tok.LastUsed)
	})

	t.Run("delete", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)
		require.NoError(t, s.CreateAPIToken(ctx, APIToken{Name: "ci", TokenHash: "hash-ci", CreatedAt: now}))

		removed, err := s.DeleteAPIToken(ctx, "ci")
		require.NoError(t, err)
		assert.True(t, removed)

		removed, err = s.DeleteAPIToken(ctx, "ci")
		require.NoError(t, err)
		assert.False(t, removed)
	})
}
