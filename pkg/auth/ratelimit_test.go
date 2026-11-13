package auth

import (
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestFailLimiter(t *testing.T) {
	t.Parallel()

	t.Run("allows_within_budget", func(t *testing.T) {
		now := time.Unix(0, 0)
		l := NewFailLimiter(3, time.Minute)
		l.now = func() time.Time { return now }

		assert.True(t, l.Allow("1.2.3.4"))
		assert.True(t, l.Allow("1.2.3.4"))
		assert.True(t, l.Allow("1.2.3.4"))
		assert.False(t, l.Allow("1.2.3.4"))
		assert.True(t, l.Allow("5.6.7.8"))

		now = now.Add(time.Minute)
		assert.True(t, l.Allow("1.2.3.4"))
	})

	t.Run("reset", func(t *testing.T) {
		now := time.Unix(0, 0)
		l := NewFailLimiter(2, time.Minute)
		l.now = func() time.Time { return now }

		assert.True(t, l.Allow("a"))
		assert.True(t, l.Allow("a"))
		assert.False(t, l.Allow("a"))

		l.Reset("a")
		assert.True(t, l.Allow("a"))
	})

	t.Run("spray_stays_bounded", func(t *testing.T) {
		now := time.Unix(0, 0)
		l := NewFailLimiter(1, time.Minute)
		l.now = func() time.Time { return now }

		// more fresh keys than the bound, all inside one window: eviction keeps
		// memory at the cap instead of growing with the spray
		for i := 0; i < limiterMaxTracked+100; i++ {
			l.Allow(strconv.Itoa(i))
		}
		assert.Len(t, l.wins, limiterMaxTracked)
	})

	t.Run("retry_after", func(t *testing.T) {
		now := time.Unix(0, 0)
		l := NewFailLimiter(1, time.Minute)
		l.now = func() time.Time { return now }

		assert.Equal(t, time.Duration(0), l.RetryAfter("k"))
		assert.True(t, l.Allow("k"))
		now = now.Add(20 * time.Second)
		assert.Equal(t, 40*time.Second, l.RetryAfter("k"))
		now = now.Add(time.Minute)
		assert.Equal(t, time.Duration(0), l.RetryAfter("k"))
	})

	t.Run("prune_keeps_map_bounded", func(t *testing.T) {
		now := time.Unix(0, 0)
		l := NewFailLimiter(1, time.Minute)
		l.now = func() time.Time { return now }

		for i := 0; i < limiterMaxTracked+50; i++ {
			l.Allow("10.0.0." + strconv.Itoa(i))
		}
		now = now.Add(2 * time.Minute)
		l.Allow("fresh")
		// only the fresh window survives the prune, not just the cap bound
		assert.Len(t, l.wins, 1)
		_, ok := l.wins["fresh"]
		assert.True(t, ok)
	})
}
