package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jentfoo/ajent/pkg/config"
)

// checkControlEnabled gates startup on ajent's control socket: the registry it
// feeds is swarm's only window into sessions. Missing file reads as disabled,
// the default is off.
func checkControlEnabled() error {
	home, err := config.Home()
	if err != nil {
		return fmt.Errorf("resolve ajent home: %w", err)
	}
	path := filepath.Join(home, config.ConfigFileName)
	raw, _, err := config.ReadForSave(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			raw = nil
		} else {
			return fmt.Errorf("read %s: %w", path, err)
		}
	}
	var set config.Settings
	if trimmed := bytes.TrimSpace(raw); len(trimmed) > 0 {
		if err = json.Unmarshal(trimmed, &set); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	}
	if !set.Control.Enabled {
		return fmt.Errorf("ajent's control socket is disabled; "+
			"set \"control\": {\"enabled\": true} in %s", path)
	}
	return nil
}
