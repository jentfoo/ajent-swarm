package auth

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/store"
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
}

func TestSetPasswordNoUser(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)
	err := svc.SetPassword(t.Context(), "x")
	assert.ErrorContains(t, err, "no user row")
}

func TestBootstrap(t *testing.T) {
	t.Parallel()

	svc, _, _ := newTestAuth(t)
	ctx := t.Context()
	require.NoError(t, svc.EnsureUser(ctx, "jent"))

	t.Run("required before seeding", func(t *testing.T) {
		assert.True(t, svc.BootstrapRequired())
	})

	t.Run("sets the first password", func(t *testing.T) {
		require.NoError(t, svc.Bootstrap(ctx, "hunter2"))
		assert.False(t, svc.BootstrapRequired())

		_, err := svc.Login(ctx, "jent", "hunter2")
		assert.NoError(t, err)
	})

	t.Run("refuses later attempts", func(t *testing.T) {
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
		{name: "valid credentials", username: "jent", password: "hunter2"},
		{name: "unknown user", username: "nobody", password: "hunter2", wantErr: ErrInvalidCredentials},
		{name: "wrong password", username: "jent", password: "nope", wantErr: ErrInvalidCredentials},
		{name: "empty password", username: "jent", password: "", wantErr: ErrInvalidCredentials},
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

func TestNewServiceDefaults(t *testing.T) {
	t.Parallel()

	// no options: production defaults hold, cost 12 included
	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	svc, err := NewService(st)
	require.NoError(t, err)
	assert.Equal(t, 12, svc.bcryptCost, "production ships cost 12")
}
