package store

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthSessions(t *testing.T) {
	t.Parallel()

	t.Run("create and get", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)
		sess := AuthSession{
			TokenHash: "aaaa",
			CreatedAt: now,
			LastSeen:  now,
			ExpiresAt: now.Add(time.Hour),
		}
		require.NoError(t, s.CreateAuthSession(ctx, sess))

		got, err := s.AuthSessionByHash(ctx, "aaaa")
		require.NoError(t, err)
		assert.Equal(t, sess, got)

		_, err = s.AuthSessionByHash(ctx, "missing")
		require.ErrorIs(t, err, ErrNotFound)
	})

	t.Run("touch slides expiry", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)
		require.NoError(t, s.CreateAuthSession(ctx, AuthSession{
			TokenHash: "aaaa",
			CreatedAt: now,
			LastSeen:  now,
			ExpiresAt: now.Add(time.Hour),
		}))
		require.NoError(t, s.CreateAuthSession(ctx, AuthSession{
			TokenHash: "bbbb",
			CreatedAt: now,
			LastSeen:  now,
			ExpiresAt: now.Add(time.Hour),
		}))

		later := now.Add(30 * time.Minute)
		require.NoError(t, s.TouchAuthSession(ctx, "aaaa", later, later.Add(time.Hour)))

		got, err := s.AuthSessionByHash(ctx, "aaaa")
		require.NoError(t, err)
		assert.Equal(t, later, got.LastSeen)
		assert.Equal(t, later.Add(time.Hour), got.ExpiresAt)

		untouched, err := s.AuthSessionByHash(ctx, "bbbb")
		require.NoError(t, err)
		assert.Equal(t, now, untouched.LastSeen)
	})

	t.Run("delete", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)
		require.NoError(t, s.CreateAuthSession(ctx, AuthSession{TokenHash: "aaaa", ExpiresAt: now}))

		require.NoError(t, s.DeleteAuthSession(ctx, "aaaa"))
		_, err := s.AuthSessionByHash(ctx, "aaaa")
		require.ErrorIs(t, err, ErrNotFound)

		require.NoError(t, s.DeleteAuthSession(ctx, "aaaa"))
	})

	t.Run("delete expired", func(t *testing.T) {
		s := newTestStore(t)
		ctx := t.Context()
		now := time.Unix(1_700_000_000, 0)
		require.NoError(t, s.CreateAuthSession(ctx, AuthSession{TokenHash: "stale", ExpiresAt: now.Add(-time.Minute)}))
		require.NoError(t, s.CreateAuthSession(ctx, AuthSession{TokenHash: "fresh", ExpiresAt: now.Add(time.Minute)}))

		n, err := s.DeleteExpiredSessions(ctx, now)
		require.NoError(t, err)
		assert.Equal(t, int64(1), n)

		_, err = s.AuthSessionByHash(ctx, "stale")
		require.ErrorIs(t, err, ErrNotFound)

		_, err = s.AuthSessionByHash(ctx, "fresh")
		assert.NoError(t, err)
	})
}
