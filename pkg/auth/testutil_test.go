package auth

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"

	"github.com/jentfoo/ajent-swarm/pkg/store"
)

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
