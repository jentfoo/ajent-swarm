package main

import (
	"testing"

	"github.com/spf13/pflag"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFlags(t *testing.T) {
	t.Parallel()

	t.Run("parse", func(t *testing.T) {
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
				name: "explicit_values",
				argv: []string{"--port", "9000", "--host", "0.0.0.0", "--state", "/tmp/swarm",
					"--pidfile", "/tmp/pid", "--log", "/tmp/log", "--ajent-bin", "/usr/bin/ajent"},
				want: cliFlags{port: 9000, host: "0.0.0.0", state: "/tmp/swarm",
					pidfile: "/tmp/pid", logPath: "/tmp/log", ajentBin: "/usr/bin/ajent",
					runRetentionDays: 30, runRetentionMax: 10000,
					logMaxMB: 50, logBackups: 2},
			},
			{
				name: "password_given",
				argv: []string{"--password", "hunter2"},
				want: cliFlags{port: defaultPort, host: "127.0.0.1", password: "hunter2",
					passwordGiven: true, runRetentionDays: 30, runRetentionMax: 10000,
					logMaxMB: 50, logBackups: 2},
			},
			{
				name: "boolean_flags",
				argv: []string{"--daemon", "--allow-remote-bootstrap", "--kill-children-on-shutdown"},
				want: cliFlags{port: defaultPort, host: "127.0.0.1", daemon: true,
					allowRemoteBootstrap: true, killChildren: true,
					runRetentionDays: 30, runRetentionMax: 10000,
					logMaxMB: 50, logBackups: 2},
			},
			{
				name: "retention_overrides",
				argv: []string{"--run-retention-days", "7", "--run-retention-max", "500"},
				want: cliFlags{port: defaultPort, host: "127.0.0.1",
					runRetentionDays: 7, runRetentionMax: 500,
					logMaxMB: 50, logBackups: 2},
			},
			{
				name: "rotation_overrides",
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
	})

	t.Run("parse_errors", func(t *testing.T) {
		tests := []struct {
			name    string
			argv    []string
			wantErr string
		}{
			{name: "unknown_flag", argv: []string{"--nope"}, wantErr: "unknown flag: --nope"},
			{name: "help_requested", argv: []string{"--help"}, wantErr: pflag.ErrHelp.Error()},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				_, err := parseFlags(tt.argv)
				assert.ErrorContains(t, err, tt.wantErr)
			})
		}
	})

	t.Run("validate", func(t *testing.T) {
		tests := []struct {
			name    string
			flags   cliFlags
			wantErr string
		}{
			{name: "defaults", flags: cliFlags{port: defaultPort}},
			{name: "min_bound", flags: cliFlags{port: minPort}},
			{name: "max_bound", flags: cliFlags{port: maxPort}},
			{
				name:    "zero_port",
				flags:   cliFlags{port: 0},
				wantErr: "--port must be between 1 and 65535, not 0",
			},
			{
				name:    "negative_port",
				flags:   cliFlags{port: -1},
				wantErr: "--port must be between 1 and 65535, not -1",
			},
			{
				name:    "above_max",
				flags:   cliFlags{port: maxPort + 1},
				wantErr: "--port must be between 1 and 65535, not 65536",
			},
			{
				name:    "empty_password_rejected",
				flags:   cliFlags{port: defaultPort, password: "   ", passwordGiven: true},
				wantErr: "--password must not be empty",
			},
			{
				name:    "negative_retention_days",
				flags:   cliFlags{port: defaultPort, runRetentionDays: -1},
				wantErr: "--run-retention-days must not be negative",
			},
			{
				name:    "negative_retention_max",
				flags:   cliFlags{port: defaultPort, runRetentionMax: -5},
				wantErr: "--run-retention-max must not be negative",
			},
			{
				name:    "negative_log_size",
				flags:   cliFlags{port: defaultPort, logMaxMB: -1},
				wantErr: "--log-max-mb must not be negative",
			},
			{
				name:    "negative_log_backups",
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
	})

	t.Run("lifecycle_args", func(t *testing.T) {
		t.Run("defaults", func(t *testing.T) {
			a, err := parseLifecycleArgs(cmdStop, nil)
			require.NoError(t, err)
			assert.Equal(t, lifecycleArgs{}, a)
		})

		t.Run("state_and_pidfile", func(t *testing.T) {
			a, err := parseLifecycleArgs(cmdStatus, []string{"--state", "/s", "--pidfile", "/p.pid"})
			require.NoError(t, err)
			assert.Equal(t, lifecycleArgs{state: "/s", pidfile: "/p.pid"}, a)
		})

		t.Run("help_requested", func(t *testing.T) {
			_, err := parseLifecycleArgs(cmdStop, []string{"--help"})
			assert.ErrorIs(t, err, pflag.ErrHelp)
		})

		t.Run("positional_refused", func(t *testing.T) {
			_, err := parseLifecycleArgs(cmdStop, []string{"extra"})
			assert.ErrorContains(t, err, "unexpected argument")
		})
	})
}
