package fleet

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProc(t *testing.T) {
	t.Parallel()

	t.Run("launch_argv", func(t *testing.T) {
		tests := []struct {
			name string
			req  LaunchRequest
			want []string
		}{
			{"new", LaunchRequest{Workspace: "/w"}, []string{"ajent", "--serve"}},
			{"empty_mode_is_new", LaunchRequest{Workspace: "/w", Mode: ""}, []string{"ajent", "--serve"}},
			{"resume_by_id", LaunchRequest{Workspace: "/w", Mode: LaunchResume, Target: "01JABC"},
				[]string{"ajent", "--serve", "--resume", "01JABC"}},
			{"resume_by_name", LaunchRequest{Workspace: "/w", Mode: LaunchResume, Target: "fix-auth"},
				[]string{"ajent", "--serve", "--resume", "fix-auth"}},
			{"continue", LaunchRequest{Workspace: "/w", Mode: LaunchContinue},
				[]string{"ajent", "--serve", "--continue"}},
			{"session_name", LaunchRequest{Workspace: "/w", Mode: LaunchSession, Target: "daily"},
				[]string{"ajent", "--serve", "--session", "daily"}},
			{"with_model", LaunchRequest{Workspace: "/w", Model: "anthropic/claude-x"},
				[]string{"ajent", "--serve", "--model", "anthropic/claude-x"}},
			{"read_only", LaunchRequest{Workspace: "/w", Permission: PermReadOnly},
				[]string{"ajent", "--serve", "--read-only"}},
			{"allow_autowrite", LaunchRequest{Workspace: "/w", Permission: PermAllowAutowrite},
				[]string{"ajent", "--serve", "--allow-autowrite"}},
			{"full_request", LaunchRequest{Workspace: "/w", Mode: LaunchResume, Target: "ops",
				Model: "m1", Permission: PermAllowAll},
				[]string{"ajent", "--serve", "--resume", "ops", "--model", "m1", "--allow-all"}},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				assert.Equal(t, tt.want, tt.req.argv("ajent"))
				assert.Equal(t, strings.Join(tt.want[1:], " "), tt.req.summary())
			})
		}
	})

	t.Run("command_prefix", func(t *testing.T) {
		tests := []struct {
			name   string
			prefix string
			target string // rides the argv as hostile content
			want   string // the sh script argv[2]
		}{
			{
				name:   "plain_prefix",
				prefix: "exec env FOO=bar",
				target: "daily",
				want:   `exec env FOO=bar '/opt/ajent' '--serve' '--session' 'daily'`,
			},
			{
				name:   "hostile_args_stay_literal",
				prefix: "timeout 300",
				target: `x'; $(rm -rf /); 'y`,
				want:   `timeout 300 '/opt/ajent' '--serve' '--session' 'x'\''; $(rm -rf /); '\''y'`,
			},
			{
				name:   "subshell_attempt_quoted",
				prefix: "sh -c",
				target: `one; two && three | four`,
				want:   `sh -c '/opt/ajent' '--serve' '--session' 'one; two && three | four'`,
			},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				req := LaunchRequest{Workspace: "/w", Mode: LaunchSession,
					Target: tt.target, CommandPrefix: tt.prefix}
				argv := req.argv("/opt/ajent")
				require.Len(t, argv, 3)
				assert.Equal(t, "sh", argv[0])
				assert.Equal(t, "-c", argv[1])
				assert.Equal(t, tt.want, argv[2])
			})
		}
	})

	t.Run("shell_quote_through_sh", func(t *testing.T) {
		// the quoting contract, proven against a real shell: every hostile arg
		// must survive as one literal word
		args := []string{"", "plain", `two words`, `$HOME`, "`whoami`", "a'b\"c",
			"semi;pipe|amp&", "$(danger)"}
		quoted := make([]string, 0, len(args))
		for _, a := range args {
			quoted = append(quoted, shellQuote(a))
		}
		run := exec.CommandContext(t.Context(), "sh", "-c",
			`printf '%s\n' `+strings.Join(quoted, " "))
		out, err := run.Output()
		require.NoError(t, err)
		assert.Equal(t, strings.Join(args, "\n")+"\n", string(out))
	})

	t.Run("launch_validate", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "not-a-dir")
		require.NoError(t, os.WriteFile(file, nil, 0o600))

		tests := []struct {
			name    string
			req     LaunchRequest
			wantErr string
		}{
			{"new_ok", LaunchRequest{Workspace: dir}, ""},
			{"resume_ok", LaunchRequest{Workspace: dir, Mode: LaunchResume, Target: "x"}, ""},
			{"continue_ok", LaunchRequest{Workspace: dir, Mode: LaunchContinue}, ""},
			{"session_ok", LaunchRequest{Workspace: dir, Mode: LaunchSession, Target: "daily"}, ""},
			{"trims_fields", LaunchRequest{Workspace: " " + dir + " ", Mode: LaunchSession, Target: " daily "}, ""},
			{"empty_workspace", LaunchRequest{}, "workspace is required"},
			{"missing_dir", LaunchRequest{Workspace: filepath.Join(dir, "nope")}, "no such file"},
			{"workspace_is_file", LaunchRequest{Workspace: file}, "not a directory"},
			{"bare_resume", LaunchRequest{Workspace: dir, Mode: LaunchResume}, "resume needs a target"},
			{"bad_session_name", LaunchRequest{Workspace: dir, Mode: LaunchSession, Target: "-bad name"},
				"session name"},
			{"empty_session_name", LaunchRequest{Workspace: dir, Mode: LaunchSession}, "session name"},
			{"unknown_mode", LaunchRequest{Workspace: dir, Mode: "fork"}, "unknown mode"},
			{"unknown_permission", LaunchRequest{Workspace: dir, Permission: "yolo"}, "unknown permission"},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				err := tt.req.validate()
				if tt.wantErr == "" {
					require.NoError(t, err)
					return
				}
				require.ErrorIs(t, err, ErrInvalidLaunch)
				assert.Contains(t, err.Error(), tt.wantErr)
			})
		}
	})
}
