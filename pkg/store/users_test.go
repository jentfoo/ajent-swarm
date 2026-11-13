package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUsers(t *testing.T) {
	t.Parallel()

	t.Run("upsert_password", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()

		require.NoError(t, s.UpsertUserPassword(ctx, "jent", "$2a$12$first"))
		require.NoError(t, s.UpsertUserPassword(ctx, "jent", "$2a$12$second"))

		u, err := s.User(ctx, "jent")
		require.NoError(t, err)
		assert.Equal(t, "jent", u.Username)
		assert.Equal(t, "$2a$12$second", u.PasswordHash)
	})

	t.Run("get_user", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		require.NoError(t, s.UpsertUserPassword(ctx, "jent", ""))

		u, err := s.User(ctx, "jent")
		require.NoError(t, err)
		assert.Empty(t, u.PasswordHash)

		_, err = s.User(ctx, "nobody")
		require.ErrorIs(t, err, ErrNotFound)
	})

	t.Run("sole_user", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		require.NoError(t, s.UpsertUserPassword(ctx, "jent", "$2a$12$hash"))

		u, err := s.SoleUser(ctx)
		require.NoError(t, err)
		assert.Equal(t, User{Username: "jent", PasswordHash: "$2a$12$hash"}, u)
	})

	t.Run("usable_credential", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()

		ok, err := s.HasUsableCredential(ctx)
		require.NoError(t, err)
		assert.False(t, ok)

		require.NoError(t, s.UpsertUserPassword(ctx, "jent", ""))
		ok, err = s.HasUsableCredential(ctx)
		require.NoError(t, err)
		assert.False(t, ok)

		require.NoError(t, s.UpsertUserPassword(ctx, "jent", "$2a$12$hash"))
		ok, err = s.HasUsableCredential(ctx)
		require.NoError(t, err)
		assert.True(t, ok)
	})
}
