package app

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// writeScript creates an executable shell script with the given body.
func writeScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755))
	return path
}

func TestBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell scripts are unix only")
	}
	t.Parallel()

	dir := t.TempDir()

	tests := []struct {
		name    string
		bin     string // written into dir when empty
		body    string
		wantVer string
		wantErr string
	}{
		{
			name:    "reports version",
			body:    `echo "ajent version v9.9.9"`,
			wantVer: "v9.9.9",
		},
		{
			name:    "devel build still parses",
			body:    `echo "ajent version devel"`,
			wantVer: "devel",
		},
		{
			name:    "fails loudly on nonzero exit",
			body:    `exit 3`,
			wantErr: "--version",
		},
		{
			name:    "fails loudly without output",
			body:    `exit 0`,
			wantErr: "no usable --version output",
		},
		{
			name:    "missing binary names the flag",
			bin:     filepath.Join(dir, "absent"),
			wantErr: "--ajent-bin",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bin := tt.bin
			if bin == "" {
				bin = writeScript(t, dir, "ajent-"+tt.name, tt.body)
			}
			path, version, err := locateAjent(t.Context(), bin)
			if tt.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tt.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, bin, path)
			assert.Equal(t, tt.wantVer, version)
		})
	}
}
