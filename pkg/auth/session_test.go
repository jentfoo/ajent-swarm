package auth

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSession(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)
	ctx := t.Context()
	require.NoError(t, svc.EnsureUser(ctx, "jent"))
	require.NoError(t, svc.SetPassword(ctx, "hunter2"))

	t.Run("validates a fresh token", func(t *testing.T) {
		token, err := svc.Login(ctx, "jent", "hunter2")
		require.NoError(t, err)

		p, renewed, err := svc.Session(ctx, token)
		require.NoError(t, err)
		assert.Equal(t, ViaCookie, p.Via)
		assert.False(t, renewed, "fresh session needs no slide yet")

		err = svc.Logout(ctx, token)
		require.NoError(t, err)

		_, _, err = svc.Session(ctx, token)
		require.ErrorIs(t, err, ErrInvalidSession)
	})

	t.Run("rejects empty and unknown tokens", func(t *testing.T) {
		for _, token := range []string{"", "garbage"} {
			_, _, err := svc.Session(ctx, token)
			assert.ErrorIs(t, err, ErrInvalidSession, "token %q", token)
		}
	})
}

func TestSessionExpiry(t *testing.T) {
	t.Parallel()

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
}

func TestSessionSlides(t *testing.T) {
	t.Parallel()

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
	assert.True(t, renewed, "the elapsed use gap slid again")
}

func TestSessionCookieShape(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)

	c := svc.SessionCookie("rawtoken")
	assert.Equal(t, SessionCookieName, c.Name)
	assert.Equal(t, "rawtoken", c.Value)
	assert.True(t, c.HttpOnly)
	assert.Equal(t, http.SameSiteLaxMode, c.SameSite)
	assert.Positive(t, c.MaxAge)

	cleared := svc.ClearSessionCookie()
	assert.Equal(t, -1, cleared.MaxAge)
}
