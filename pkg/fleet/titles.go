package fleet

import (
	"context"
	"errors"
	"strings"
	"time"
)

// titleWriteWait bounds one write-through; SQLite under WAL answers fast, so
// anything slower means the store is wedged and the caller may retry.
const titleWriteWait = 5 * time.Second

// ErrNoTitleStore reports a rename against a manager started without a store,
// which cannot remember titles across restarts.
var ErrNoTitleStore = errors.New("no session title store configured")

// TitleStore persists swarm-side display titles keyed by session id, so a
// rename from any surface survives restarts and never touches ajent's own
// session names or resume targets.
type TitleStore interface {
	SetSessionTitle(ctx context.Context, sessionID, title string) error
	SessionTitles(ctx context.Context) (map[string]string, error)
}

// maxTitleRunes bounds one display title at the fleet boundary; the store
// clips too, but a bounded write keeps the cache and the store in step.
const maxTitleRunes = 120

// loadTitles reads every stored title into the manager's cache on start.
// Failures log once and leave the cache empty: labels fall back to names and
// paths until a rename writes through.
func (m *Manager) loadTitles(ctx context.Context, store TitleStore) {
	wctx, cancel := context.WithTimeout(ctx, titleWriteWait)
	defer cancel()
	titles, err := store.SessionTitles(wctx)
	if err != nil {
		m.log.Warn("reading session titles failed", "err", err)
		return
	}
	m.mu.Lock()
	m.titles = titles
	m.mu.Unlock()
}

// titleFor looks one cached display title up; empty when none is stored.
func (m *Manager) titleFor(sessionID string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.titles[sessionID]
}

// SetTitle writes through one display title to the store and cache. An empty
// title clears it, falling back to names and paths everywhere.
func (m *Manager) SetTitle(ctx context.Context, sessionID, title string) error {
	if strings.TrimSpace(sessionID) == "" {
		return ErrUnknownSession
	}
	if m.titleStore == nil {
		return ErrNoTitleStore
	}

	title = clipRunes(title, maxTitleRunes)
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), titleWriteWait)
	defer cancel()
	if err := m.titleStore.SetSessionTitle(wctx, sessionID, title); err != nil {
		return err
	}
	m.mu.Lock()
	if m.titles == nil {
		m.titles = make(map[string]string)
	}
	if title == "" {
		delete(m.titles, sessionID)
	} else {
		m.titles[sessionID] = title
	}
	m.mu.Unlock()
	return nil
}
