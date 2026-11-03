package auth

import (
	"sync"
	"time"
)

// failWindow is one source's failure budget inside a fixed window.
type failWindow struct {
	count int
	start time.Time
}

// limiterMaxTracked bounds the key map; expired entries prune away once it
// fills, and a same-window IP spray evicts one entry to hold the bound.
const limiterMaxTracked = 4096

// FailLimiter counts attempts per key inside a fixed window that rolls once
// it expires, so credential stuffing slows to one window's budget. A
// successful login clears the key's count.
type FailLimiter struct {
	mu     sync.Mutex
	wins   map[string]*failWindow
	max    int           // failures allowed per key per window
	window time.Duration // budget window length
	now    func() time.Time
}

// NewFailLimiter allows max failures per key inside window before refusing.
func NewFailLimiter(max int, window time.Duration) *FailLimiter {
	return &FailLimiter{
		wins:   make(map[string]*failWindow),
		max:    max,
		window: window,
		now:    time.Now,
	}
}

// Allow reports whether key may attempt now, counting one budget slot when
// its window still has room.
func (l *FailLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	w := l.windowFor(key)
	if w.count >= l.max {
		return false
	}
	w.count++
	return true
}

// Reset clears key's failure count after a success.
func (l *FailLimiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.wins, key)
}

// RetryAfter reports how long key stays refused, zero when it may proceed.
func (l *FailLimiter) RetryAfter(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	w := l.windowFor(key)
	if w.count < l.max {
		return 0
	}
	return l.window - l.now().Sub(w.start)
}

// windowFor returns key's current window, rolling it when expired. Once the
// map fills past the tracking bound, expired entries prune away and one
// arbitrary entry evicts, keeping memory bounded under a source spray.
func (l *FailLimiter) windowFor(key string) *failWindow {
	now := l.now()
	if w, ok := l.wins[key]; ok && now.Sub(w.start) < l.window {
		return w
	}
	if len(l.wins) >= limiterMaxTracked {
		for k, w := range l.wins {
			if now.Sub(w.start) >= l.window {
				delete(l.wins, k)
			}
		}
		for k := range l.wins { // nothing expired: drop one to make room
			delete(l.wins, k)
			break
		}
	}
	w := &failWindow{start: now}
	l.wins[key] = w
	return w
}
