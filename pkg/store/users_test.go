package store

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUpsertUserPassword(t *testing.T) {
	t.Parallel()

	s := newTestStore(t)
	ctx := t.Context()

	require.NoError(t, s.UpsertUserPassword(ctx, "jent", "$2a$12$first"))
	require.NoError(t, s.UpsertUserPassword(ctx, "jent", "$2a$12$second"))

	u, err := s.User(ctx, "jent")
	require.NoError(t, err)
	assert.Equal(t, "jent", u.Username)
	assert.Equal(t, "$2a$12$second", u.PasswordHash)
}

func TestUser(t *testing.T) {
	t.Parallel()

	s := newTestStore(t)
	ctx := t.Context()
	require.NoError(t, s.UpsertUserPassword(ctx, "jent", ""))

	u, err := s.User(ctx, "jent")
	require.NoError(t, err)
	assert.Empty(t, u.PasswordHash)

	_, err = s.User(ctx, "nobody")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestSoleUser(t *testing.T) {
	t.Parallel()

	s := newTestStore(t)
	ctx := t.Context()
	require.NoError(t, s.UpsertUserPassword(ctx, "jent", "$2a$12$hash"))

	u, err := s.SoleUser(ctx)
	require.NoError(t, err)
	assert.Equal(t, User{Username: "jent", PasswordHash: "$2a$12$hash"}, u)
}

func TestHasUsableCredential(t *testing.T) {
	t.Parallel()

	s := newTestStore(t)
	ctx := t.Context()

	ok, err := s.HasUsableCredential(ctx)
	require.NoError(t, err)
	assert.False(t, ok)

	require.NoError(t, s.UpsertUserPassword(ctx, "jent", ""))
	ok, err = s.HasUsableCredential(ctx)
	require.NoError(t, err)
	assert.False(t, ok, "empty hash is not usable")

	require.NoError(t, s.UpsertUserPassword(ctx, "jent", "$2a$12$hash"))
	ok, err = s.HasUsableCredential(ctx)
	require.NoError(t, err)
	assert.True(t, ok)
}
