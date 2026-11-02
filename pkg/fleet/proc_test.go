package fleet

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLaunchArgv(t *testing.T) {
	t.Parallel()
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
}

func TestLaunchValidate(t *testing.T) {
	t.Parallel()
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
}

func TestInvalidLaunchSentinel(t *testing.T) {
	t.Parallel()
	err := invalidLaunch("boom %d", 7)
	require.ErrorIs(t, err, ErrInvalidLaunch)
	assert.Equal(t, "boom 7", err.Error())
}
