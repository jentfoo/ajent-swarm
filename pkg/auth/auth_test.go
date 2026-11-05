package auth

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/store"
)

func TestAuth(t *testing.T) {
	t.Parallel()

	t.Run("ensure_user", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()

		require.NoError(t, svc.EnsureUser(ctx, "jent"))
		assert.Equal(t, "jent", svc.username)

		// a second start adopts the existing row instead of reseeding
		require.NoError(t, svc.EnsureUser(ctx, "someoneelse"))
		assert.Equal(t, "jent", svc.username)
	})

	t.Run("set_password", func(t *testing.T) {
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

	t.Run("set_password_rejects_too_long", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		ctx := t.Context()
		require.NoError(t, svc.EnsureUser(ctx, "jent"))

		err := svc.SetPassword(ctx, strings.Repeat("a", MaxPasswordBytes+1))
		require.ErrorIs(t, err, ErrPasswordTooLong)

		// the boundary value itself hashes fine
		require.NoError(t, svc.SetPassword(ctx, strings.Repeat("a", MaxPasswordBytes)))
	})

	t.Run("set_password_without_user", func(t *testing.T) {
		svc, _, _ := newTestAuth(t)
		err := svc.SetPassword(t.Context(), "x")
		assert.ErrorContains(t, err, "no user row")
	})

	t.Run("bootstrap", func(t *testing.T) {
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
	})

	t.Run("login", func(t *testing.T) {
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
	})
}

// newTestAuth builds a service over a throwaway store with a controllable
// clock and cheap hashing, seeded with the given unix username.
func newTestAuth(t *testing.T, opts ...Option) (*Service, *store.Store, *testClock) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), store.FileName))
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	clock := &testClock{now: time.Unix(1_700_000_000, 0)}
	opts = append([]Option{
		WithClock(clock.Now),
		WithBcryptCost(bcrypt.MinCost), // keep the suite fast; cost 12 is covered by defaults
	}, opts...)
	svc, err := NewService(st, opts...)
	require.NoError(t, err)
	return svc, st, clock
}

// testClock is a mutable wall clock for expiry tests.
type testClock struct {
	now time.Time
}

// Now satisfies the service's clock seam.
func (c *testClock) Now() time.Time { return c.now }

// Advance moves the clock forward.
func (c *testClock) Advance(d time.Duration) { c.now = c.now.Add(d) }
