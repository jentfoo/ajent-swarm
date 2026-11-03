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
			want: cliFlags{port: defaultPort, host: "127.0.0.1",
				runRetentionDays: 30, runRetentionMax: 10000,
				logMaxMB: 50, logBackups: 2},
		},
		{
			name: "explicit values",
			argv: []string{"--port", "9000", "--host", "0.0.0.0", "--state", "/tmp/swarm",
				"--pidfile", "/tmp/pid", "--log", "/tmp/log", "--ajent-bin", "/usr/bin/ajent"},
			want: cliFlags{port: 9000, host: "0.0.0.0", state: "/tmp/swarm",
				pidfile: "/tmp/pid", logPath: "/tmp/log", ajentBin: "/usr/bin/ajent",
				runRetentionDays: 30, runRetentionMax: 10000,
				logMaxMB: 50, logBackups: 2},
		},
		{
			name: "equals form",
			argv: []string{"--port=1234", "--host=::1"},
			want: cliFlags{port: 1234, host: "::1", runRetentionDays: 30, runRetentionMax: 10000,
				logMaxMB: 50, logBackups: 2},
		},
		{
			name: "daemon flag",
			argv: []string{"--daemon"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1", daemon: true,
				runRetentionDays: 30, runRetentionMax: 10000,
				logMaxMB: 50, logBackups: 2},
		},
		{
			name: "password given",
			argv: []string{"--password", "hunter2"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1", password: "hunter2",
				passwordGiven: true, runRetentionDays: 30, runRetentionMax: 10000,
				logMaxMB: 50, logBackups: 2},
		},
		{
			name: "remote bootstrap allowed",
			argv: []string{"--allow-remote-bootstrap"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1", allowRemoteBootstrap: true,
				runRetentionDays: 30, runRetentionMax: 10000,
				logMaxMB: 50, logBackups: 2},
		},
		{
			name: "kill children on shutdown",
			argv: []string{"--kill-children-on-shutdown"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1", killChildren: true,
				runRetentionDays: 30, runRetentionMax: 10000,
				logMaxMB: 50, logBackups: 2},
		},
		{
			name: "retention overrides",
			argv: []string{"--run-retention-days", "7", "--run-retention-max", "500"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1",
				runRetentionDays: 7, runRetentionMax: 500,
				logMaxMB: 50, logBackups: 2},
		},
		{
			name: "rotation overrides",
			argv: []string{"--log-max-mb", "10", "--log-backups", "5"},
			want: cliFlags{port: defaultPort, host: "127.0.0.1",
				runRetentionDays: 30, runRetentionMax: 10000,
				logMaxMB: 10, logBackups: 5},
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
		{
			name:    "negative retention days",
			flags:   cliFlags{port: defaultPort, runRetentionDays: -1},
			wantErr: "--run-retention-days must not be negative",
		},
		{
			name:    "negative retention max",
			flags:   cliFlags{port: defaultPort, runRetentionMax: -5},
			wantErr: "--run-retention-max must not be negative",
		},
		{
			name:    "negative log size",
			flags:   cliFlags{port: defaultPort, logMaxMB: -1},
			wantErr: "--log-max-mb must not be negative",
		},
		{
			name:    "negative log backups",
			flags:   cliFlags{port: defaultPort, logBackups: -1},
			wantErr: "--log-backups must not be negative",
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

func TestParseLifecycleArgs(t *testing.T) {
	t.Parallel()

	t.Run("defaults", func(t *testing.T) {
		a, err := parseLifecycleArgs(cmdStop, nil)
		require.NoError(t, err)
		assert.Equal(t, lifecycleArgs{}, a)
	})

	t.Run("state and pidfile", func(t *testing.T) {
		a, err := parseLifecycleArgs(cmdStatus, []string{"--state", "/s", "--pidfile", "/p.pid"})
		require.NoError(t, err)
		assert.Equal(t, lifecycleArgs{state: "/s", pidfile: "/p.pid"}, a)
	})

	t.Run("help requested", func(t *testing.T) {
		_, err := parseLifecycleArgs(cmdStop, []string{"--help"})
		assert.ErrorIs(t, err, pflag.ErrHelp)
	})

	t.Run("positional refused", func(t *testing.T) {
		_, err := parseLifecycleArgs(cmdStop, []string{"extra"})
		assert.ErrorContains(t, err, "unexpected argument")
	})
}
