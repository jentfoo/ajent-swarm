package auth

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestToken(t *testing.T) {
	t.Parallel()

	t.Run("create rejects duplicate names", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))

		secret, err := svc.CreateToken(ctx, "ci")
		require.NoError(t, err)
		assert.NotEmpty(t, secret)

		_, err = svc.CreateToken(ctx, "ci")
		assert.ErrorIs(t, err, ErrTokenNameTaken)
	})

	t.Run("bearer", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))

		secret, err := svc.CreateToken(ctx, "ci")
		require.NoError(t, err)

		p, err := svc.Bearer(ctx, secret)
		require.NoError(t, err)
		assert.Equal(t, ViaToken, p.Via)
		assert.Equal(t, "jent", p.Username)

		_, err = svc.Bearer(ctx, secret+"nope")
		require.ErrorIs(t, err, ErrInvalidSession)

		// an unknown secret that happens to hash to nothing must not authenticate
		_, err = svc.Bearer(ctx, "")
		assert.ErrorIs(t, err, ErrInvalidSession)
	})

	t.Run("usage slides slowly", func(t *testing.T) {
		svc, st, clock := newTestAuth(t)
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))

		secret, err := svc.CreateToken(ctx, "ci")
		require.NoError(t, err)
		toks, err := st.Tokens(ctx)
		require.NoError(t, err)
		assert.True(t, toks[0].LastUsed.IsZero())

		// first use records the timestamp
		_, err = svc.Bearer(ctx, secret)
		require.NoError(t, err)
		toks, err = st.Tokens(ctx)
		require.NoError(t, err)
		firstUsed := toks[0].LastUsed
		assert.Equal(t, clock.now, firstUsed)

		// under the slide interval: no new write
		clock.Advance(10 * time.Minute)
		_, err = svc.Bearer(ctx, secret)
		require.NoError(t, err)
		toks, err = st.Tokens(ctx)
		require.NoError(t, err)
		assert.Equal(t, firstUsed, toks[0].LastUsed)

		// past the interval: usage refreshes
		clock.Advance(time.Hour)
		_, err = svc.Bearer(ctx, secret)
		require.NoError(t, err)
		toks, err = st.Tokens(ctx)
		require.NoError(t, err)
		assert.Equal(t, clock.now, toks[0].LastUsed)
	})

	t.Run("delete", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))

		secret, err := svc.CreateToken(ctx, "ci")
		require.NoError(t, err)

		removed, err := svc.DeleteToken(ctx, "ci")
		require.NoError(t, err)
		assert.True(t, removed)

		_, err = svc.Bearer(ctx, secret)
		require.ErrorIs(t, err, ErrInvalidSession)

		removed, err = svc.DeleteToken(ctx, "ci")
		require.NoError(t, err)
		assert.False(t, removed)
	})

	t.Run("validate name", func(t *testing.T) {
		tests := []struct {
			name    string
			token   string
			wantErr bool
		}{
			{name: "letters", token: "ci"},
			{name: "mixed safe chars", token: "laptop.v2_3-a"},
			{name: "empty", token: "", wantErr: true},
			{name: "spaces", token: "my token", wantErr: true},
			{name: "slash", token: "a/b", wantErr: true},
			{name: "too long", token: string(make([]byte, 65)), wantErr: true},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				err := ValidateTokenName(tt.token)
				if tt.wantErr {
					assert.Error(t, err)
					return
				}
				assert.NoError(t, err)
			})
		}
	})
}
