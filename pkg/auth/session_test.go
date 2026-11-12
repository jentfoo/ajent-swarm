package auth

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSession(t *testing.T) {
	t.Parallel()

	t.Run("validates_a_fresh_token", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))
		require.NoError(t, svc.SetPassword(ctx, "hunter2"))

		token, err := svc.Login(ctx, "jent", "hunter2")
		require.NoError(t, err)

		p, renewed, err := svc.Session(ctx, token)
		require.NoError(t, err)
		assert.Equal(t, ViaCookie, p.Via)
		assert.False(t, renewed)
	})

	t.Run("rejects_empty_and_unknown_tokens", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()

		for _, tc := range []struct {
			name  string
			token string
		}{
			{name: "empty_token", token: ""},
			{name: "garbage_token", token: "garbage"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				_, _, err := svc.Session(ctx, tc.token)
				assert.ErrorIs(t, err, ErrInvalidSession)
			})
		}
	})

	t.Run("expires_past_ttl", func(t *testing.T) {
		svc, _, clock := newTestAuth(t, WithSessionTTL(time.Hour, time.Hour))
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))
		require.NoError(t, svc.SetPassword(ctx, "hunter2"))

		token, err := svc.Login(ctx, "jent", "hunter2")
		require.NoError(t, err)

		_, _, err = svc.Session(ctx, token)
		require.NoError(t, err)

		clock.Advance(90 * time.Minute) // past the one hour TTL
		p, _, err := svc.Session(ctx, token)
		require.ErrorIs(t, err, ErrInvalidSession)
		assert.Equal(t, Principal{}, p)
	})

	t.Run("slides_on_use", func(t *testing.T) {
		svc, _, clock := newTestAuth(t, WithSessionTTL(2*time.Hour, time.Hour))
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))
		require.NoError(t, svc.SetPassword(ctx, "hunter2"))

		token, err := svc.Login(ctx, "jent", "hunter2")
		require.NoError(t, err)

		// a small gap stays under the slide interval and renews nothing
		clock.Advance(30 * time.Minute)
		_, renewed, err := svc.Session(ctx, token)
		require.NoError(t, err)
		assert.False(t, renewed)

		// at the interval the expiry extends to now+ttl, outliving the original
		clock.Advance(30 * time.Minute) // one hour since login: first slide
		p, renewed, err := svc.Session(ctx, token)
		require.NoError(t, err)
		assert.True(t, renewed)
		assert.Equal(t, ViaCookie, p.Via)

		// past the original two-hour window the session is still alive because
		// each use extended it
		clock.Advance(90 * time.Minute) // 2.5 hours since login
		p, renewed, err = svc.Session(ctx, token)
		require.NoError(t, err)
		assert.Equal(t, "jent", p.Username)
		assert.True(t, renewed)
	})
}

func TestLogout(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)
	ctx := t.Context()
	require.NoError(t, svc.EnsureUser(ctx, "jent"))
	require.NoError(t, svc.SetPassword(ctx, "hunter2"))

	token, err := svc.Login(ctx, "jent", "hunter2")
	require.NoError(t, err)

	require.NoError(t, svc.Logout(ctx, token))

	_, _, err = svc.Session(ctx, token)
	require.ErrorIs(t, err, ErrInvalidSession)
}

func TestLogin(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)
	ctx := t.Context()
	require.NoError(t, svc.EnsureUser(ctx, "jent"))
	require.NoError(t, svc.SetPassword(ctx, "hunter2"))

	tests := []struct {
		name     string
		username string
		password string
		wantErr  error
	}{
		{name: "valid_credentials", username: "jent", password: "hunter2"},
		{name: "unknown_user", username: "nobody", password: "hunter2", wantErr: ErrInvalidCredentials},
		{name: "wrong_password", username: "jent", password: "nope", wantErr: ErrInvalidCredentials},
		{name: "empty_password", username: "jent", password: "", wantErr: ErrInvalidCredentials},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			token, err := svc.Login(ctx, tt.username, tt.password)
			if tt.wantErr != nil {
				assert.ErrorIs(t, err, tt.wantErr)
				return
			}
			require.NoError(t, err)
			assert.NotEmpty(t, token)

			p, _, err := svc.Session(ctx, token)
			require.NoError(t, err)
			assert.Equal(t, "jent", p.Username)
			assert.Equal(t, ViaCookie, p.Via)
		})
	}
}

func TestClearSessionCookie(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)

	cleared := svc.ClearSessionCookie()
	assert.Equal(t, -1, cleared.MaxAge)
}
