package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// maxSettingRunes bounds one stored setting value, every value today is a
// model key, so anything longer is garbage.
const maxSettingRunes = 200

// SetSetting writes one swarm-level setting, upserting by key. An empty value
// clears the row.
func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("setting key must not be empty")
	}
	value = strings.TrimSpace(clipRunes(value, maxSettingRunes))
	if value == "" {
		_, err := s.db.ExecContext(ctx, `DELETE FROM app_settings WHERE key = ?`, key)
		if err != nil {
			return fmt.Errorf("delete setting: %w", err)
		}
		return nil
	}

	const q = `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
	if _, err := s.db.ExecContext(ctx, q, key, value, time.Now().Unix()); err != nil {
		return fmt.Errorf("upsert setting: %w", err)
	}
	return nil
}

// Setting reads one swarm-level setting. A missing key reads back as the
// empty string, never an error.
func (s *Store) Setting(ctx context.Context, key string) (string, error) {
	if strings.TrimSpace(key) == "" {
		return "", errors.New("setting key must not be empty")
	}
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM app_settings WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read setting: %w", err)
	}
	return value, nil
}
