package fleet

import (
	"context"
	"errors"
	"strings"
	"time"
)

// SettingKeyTitleModel stores the model the one-shot session titler runs
// with. Empty (or unknown to the registry at naming time) means each session's
// own model labels it, the pre-config default.
const SettingKeyTitleModel = "title_model"

// settingWriteWait bounds one write-through; SQLite under WAL answers fast,
// so anything slower means the store is wedged and the caller may retry.
const settingWriteWait = 5 * time.Second

// ErrNoSettingStore reports a settings write against a manager started
// without a store, which cannot remember anything across restarts.
var ErrNoSettingStore = errors.New("no swarm settings store configured")

// SettingsStore persists swarm-level key/value settings in swarm's own
// database, so a configured titling model survives restarts. A missing key
// reads back as the empty string.
type SettingsStore interface {
	Setting(ctx context.Context, key string) (string, error)
	SetSetting(ctx context.Context, key, value string) error
}

// loadSettings seeds the settings cache from the store and remembers it for
// write-throughs. Failures log once and leave the cache empty: every consumer
// falls back to its default until a write lands.
func (m *Manager) loadSettings(ctx context.Context, store SettingsStore) {
	m.mu.Lock()
	m.settingStore = store
	m.mu.Unlock()

	wctx, cancel := context.WithTimeout(ctx, settingWriteWait)
	defer cancel()
	model, err := store.Setting(wctx, SettingKeyTitleModel)
	if err != nil {
		m.log.Warn("reading swarm settings failed", "err", err)
		return
	}
	m.mu.Lock()
	m.titleModel = strings.TrimSpace(model)
	m.mu.Unlock()
}

// TitleModel returns the configured session titling model, empty when unset.
func (m *Manager) TitleModel() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.titleModel
}

// SetTitleModel writes through the titling model to the store and cache. An
// empty model clears the setting, so sessions name with their own model.
func (m *Manager) SetTitleModel(ctx context.Context, model string) error {
	if m.settingStore == nil {
		return ErrNoSettingStore
	}

	model = strings.TrimSpace(model)
	wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), settingWriteWait)
	defer cancel()
	if err := m.settingStore.SetSetting(wctx, SettingKeyTitleModel, model); err != nil {
		return err
	}
	m.mu.Lock()
	m.titleModel = model
	m.mu.Unlock()
	return nil
}
