package app

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/testutil"
)

func TestCheckControlEnabled(t *testing.T) {
	// IsolateHome pins AJENT_HOME via t.Setenv, so no t.Parallel here
	home := testutil.IsolateHome(t)
	path := filepath.Join(home, "config.json")
	write := func(t *testing.T, body string) {
		t.Helper()
		require.NoError(t, os.WriteFile(path, []byte(body), 0o600))
	}

	tests := []struct {
		name    string
		body    string // written when non-empty
		missing bool
		wantErr string
	}{
		{
			name:    "missing_file_is_disabled",
			missing: true,
			wantErr: "control socket is disabled",
		},
		{
			name:    "absent_key_is_disabled",
			body:    `{ "model": "m" }`,
			wantErr: "control socket is disabled",
		},
		{
			name:    "disabled_fails_with_path",
			body:    `{ "control": { "enabled": false } }`,
			wantErr: path,
		},
		{
			name: "enabled_passes",
			body: `{ "control": { "enabled": true } }`,
		},
		{
			name: "hand_edit_artifacts_relaxed",
			body: "{ // note\n  \"control\": { \"enabled\": true, },\n}",
		},
		{
			name:    "malformed_json_fails_parse",
			body:    `{ "control": `,
			wantErr: "parse",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.missing {
				if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					require.NoError(t, err)
				}
			} else {
				write(t, tt.body)
			}
			err := checkControlEnabled()
			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
				return
			}
			require.NoError(t, err)
		})
	}
}
