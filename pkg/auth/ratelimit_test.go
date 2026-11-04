package auth

import (
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestFailLimiterAllowsWithinBudget(t *testing.T) {
	t.Parallel()

	now := time.Unix(0, 0)
	l := NewFailLimiter(3, time.Minute)
	l.now = func() time.Time { return now }

	assert.True(t, l.Allow("1.2.3.4"))
	assert.True(t, l.Allow("1.2.3.4"))
	assert.True(t, l.Allow("1.2.3.4"))
	assert.False(t, l.Allow("1.2.3.4"))
	assert.True(t, l.Allow("5.6.7.8"))

	now = now.Add(time.Minute)
	assert.True(t, l.Allow("1.2.3.4"), "an expired window opens a fresh budget")
}

func TestFailLimiterReset(t *testing.T) {
	t.Parallel()

	now := time.Unix(0, 0)
	l := NewFailLimiter(2, time.Minute)
	l.now = func() time.Time { return now }

	assert.True(t, l.Allow("a"))
	assert.True(t, l.Allow("a"))
	assert.False(t, l.Allow("a"))

	l.Reset("a")
	assert.True(t, l.Allow("a"), "a success clears the count")
}

func TestFailLimiterSprayStaysBounded(t *testing.T) {
	t.Parallel()

	now := time.Unix(0, 0)
	l := NewFailLimiter(1, time.Minute)
	l.now = func() time.Time { return now }

	// more fresh keys than the bound, all inside one window: eviction keeps
	// memory at the cap instead of growing with the spray
	for i := 0; i < limiterMaxTracked+100; i++ {
		l.Allow(strconv.Itoa(i))
	}
	assert.Len(t, l.wins, limiterMaxTracked)
}

func TestFailLimiterRetryAfter(t *testing.T) {
	t.Parallel()

	now := time.Unix(0, 0)
	l := NewFailLimiter(1, time.Minute)
	l.now = func() time.Time { return now }

	assert.Equal(t, time.Duration(0), l.RetryAfter("k"))
	assert.True(t, l.Allow("k"))
	now = now.Add(20 * time.Second)
	assert.Equal(t, 40*time.Second, l.RetryAfter("k"))
	now = now.Add(time.Minute)
	assert.Equal(t, time.Duration(0), l.RetryAfter("k"))
}

func TestFailLimiterPruneKeepsMapBounded(t *testing.T) {
	t.Parallel()

	now := time.Unix(0, 0)
	l := NewFailLimiter(1, time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < limiterMaxTracked+50; i++ {
		l.Allow("10.0.0." + strconv.Itoa(i))
	}
	now = now.Add(2 * time.Minute)
	l.Allow("fresh")
	assert.LessOrEqual(t, len(l.wins), limiterMaxTracked, "expired keys prune away")
}
