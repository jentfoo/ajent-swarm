package main

import (
	"testing"

	"github.com/spf13/pflag"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseFlags(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		argv []string
		want cliFlags
	}{
		{
			name: "defaults",
			argv: nil,
			want: cliFlags{port: defaultPort, host: "127.0.0.1"},
		},
		{
			name: "explicit values",
			argv: []string{"--port", "9000", "--host", "0.0.0.0", "--state", "/tmp/swarm",
				"--pidfile", "/tmp/pid", "--log", "/tmp/log", "--ajent-bin", "/usr/bin/ajent"},
			want: cliFlags{port: 9000, host: "0.0.0.0", state: "/tmp/swarm",
				pidfile: "/tmp/pid", logPath: "/tmp/log", ajentBin: "/usr/bin/ajent"},
		},
		{
			name: "equals form",
			argv: []string{"--port=1234", "--host=::1"},
			want: cliFlags{port: 1234, host: "::1"},
		},
		{
			name: "daemon flag",
			argv: []string{"--daemon"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1", daemon: true},
		},
		{
			name: "password given",
			argv: []string{"--password", "hunter2"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1", password: "hunter2", passwordGiven: true},
		},
		{
			name: "remote bootstrap allowed",
			argv: []string{"--allow-remote-bootstrap"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1", allowRemoteBootstrap: true},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f, err := parseFlags(tt.argv)
			require.NoError(t, err)
			assert.Equal(t, tt.want, f)
		})
	}
}

func TestParseFlagsErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		argv    []string
		wantErr string
	}{
		{name: "not a number", argv: []string{"--port", "http"}, wantErr: `invalid argument "http" for "--port" flag`},
		{name: "missing value", argv: []string{"--port"}, wantErr: "flag needs an argument"},
		{name: "unknown flag", argv: []string{"--nope"}, wantErr: "unknown flag: --nope"},
		{name: "help requested", argv: []string{"--help"}, wantErr: pflag.ErrHelp.Error()},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseFlags(tt.argv)
			assert.ErrorContains(t, err, tt.wantErr)
		})
	}
}

func TestValidate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		flags   cliFlags
		wantErr string
	}{
		{name: "defaults", flags: cliFlags{port: defaultPort}},
		{name: "min bound", flags: cliFlags{port: minPort}},
		{name: "max bound", flags: cliFlags{port: maxPort}},
		{
			name:    "zero port",
			flags:   cliFlags{port: 0},
			wantErr: "--port must be between 1 and 65535, not 0",
		},
		{
			name:    "negative port",
			flags:   cliFlags{port: -1},
			wantErr: "--port must be between 1 and 65535, not -1",
		},
		{
			name:    "above max",
			flags:   cliFlags{port: maxPort + 1},
			wantErr: "--port must be between 1 and 65535, not 65536",
		},
		{
			name:    "empty password rejected",
			flags:   cliFlags{port: defaultPort, password: "   ", passwordGiven: true},
			wantErr: "--password must not be empty",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.flags.validate()
			if tt.wantErr != "" {
				assert.EqualError(t, err, tt.wantErr)
				return
			}
			assert.NoError(t, err)
		})
	}
}
