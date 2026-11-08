package auth

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEnsureUser(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)
	ctx := t.Context()

	require.NoError(t, svc.EnsureUser(ctx, "jent"))
	assert.Equal(t, "jent", svc.username)

	// a second start adopts the existing row instead of reseeding
	require.NoError(t, svc.EnsureUser(ctx, "someoneelse"))
	assert.Equal(t, "jent", svc.username)
}

func TestSetPassword(t *testing.T) {
	t.Parallel()

	t.Run("sets_the_first_password", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))

		// login fails before any hash exists
		_, err := svc.Login(ctx, "jent", "hunter2")
		require.ErrorIs(t, err, ErrInvalidCredentials)

		require.NoError(t, svc.SetPassword(ctx, "hunter2"))
		assert.False(t, svc.BootstrapRequired())

		token, err := svc.Login(ctx, "jent", "hunter2")
		require.NoError(t, err)
		assert.NotEmpty(t, token)

		// upsert replaces the hash
		require.NoError(t, svc.SetPassword(ctx, "new-pass"))
		_, err = svc.Login(ctx, "jent", "hunter2")
		assert.ErrorIs(t, err, ErrInvalidCredentials)
	})

	t.Run("rejects_too_long", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))

		err := svc.SetPassword(ctx, strings.Repeat("a", MaxPasswordBytes+1))
		require.ErrorIs(t, err, ErrPasswordTooLong)

		// the boundary value itself hashes fine
		require.NoError(t, svc.SetPassword(ctx, strings.Repeat("a", MaxPasswordBytes)))
	})

	t.Run("without_user", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		err := svc.SetPassword(t.Context(), "x")
		assert.ErrorContains(t, err, "no user row")
	})
}

func TestBootstrap(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)
	ctx := t.Context()
	require.NoError(t, svc.EnsureUser(ctx, "jent"))

	t.Run("required_before_seeding", func(t *testing.T) {
		assert.True(t, svc.BootstrapRequired())
	})

	t.Run("sets_the_first_password", func(t *testing.T) {
		require.NoError(t, svc.Bootstrap(ctx, "hunter2"))
		assert.False(t, svc.BootstrapRequired())

		_, err := svc.Login(ctx, "jent", "hunter2")
		assert.NoError(t, err)
	})

	t.Run("refuses_later_attempts", func(t *testing.T) {
		err := svc.Bootstrap(ctx, "again")
		require.ErrorIs(t, err, ErrAlreadyBootstrapped)

		// the refused attempt changed nothing
		_, err = svc.Login(ctx, "jent", "again")
		assert.ErrorIs(t, err, ErrInvalidCredentials)
	})
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
