package fleet

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/jentfoo/ajent/pkg/session"
)

// Spawned-by labels on the session listing.
const (
	SpawnedBySwarm    = "swarm"
	SpawnedByExternal = "external"
)

// LaunchMode selects how the child attaches to session history. The empty
// mode means new.
type LaunchMode string

const (
	LaunchNew      LaunchMode = "new"
	LaunchResume   LaunchMode = "resume"
	LaunchContinue LaunchMode = "continue"
	LaunchSession  LaunchMode = "session"
)

// Permission startup flags, mutually exclusive exactly like ajent's own.
const (
	PermReadOnly       = "read-only"
	PermAllowAuto      = "allow-auto"
	PermAllowAutowrite = "allow-autowrite"
	PermAllowAll       = "allow-all"
)

var launchModes = []LaunchMode{LaunchNew, LaunchResume, LaunchContinue, LaunchSession}

var launchPermissions = []string{PermReadOnly, PermAllowAuto, PermAllowAutowrite, PermAllowAll}

// LaunchRequest asks for one headless ajent session as a child of the
// service. Resume modes map onto ajent flags exactly.
type LaunchRequest struct {
	Workspace  string     `json:"workspace"`            // directory the child runs in
	Mode       LaunchMode `json:"mode,omitempty"`       // new, resume, continue, session
	Target     string     `json:"target,omitempty"`     // id or name for resume, name for session
	Model      string     `json:"model,omitempty"`      // --model key
	Permission string     `json:"permission,omitempty"` // one of the permission flags, or empty
}

// LaunchResult reports a launched child: the session id it registered under
// once its control socket appeared, beside its process id and log file.
type LaunchResult struct {
	SessionID string `json:"sessionId"`
	PID       int    `json:"pid"`
	Workspace string `json:"workspace"`
	LogPath   string `json:"logPath"`
}

// ErrInvalidLaunch marks a launch request that failed validation.
var ErrInvalidLaunch = errors.New("invalid launch request")

type invalidLaunchError struct{ detail string }

func (e *invalidLaunchError) Error() string { return e.detail }

func (e *invalidLaunchError) Is(target error) bool { return target == ErrInvalidLaunch }

func invalidLaunch(format string, args ...any) error {
	return &invalidLaunchError{detail: fmt.Sprintf(format, args...)}
}

// normalized trims the fields and defaults the mode, so validation and argv
// always see one shape. The workspace lands absolute (when it resolves) and a
// session target in ajent's canonical form.
func (r LaunchRequest) normalized() LaunchRequest {
	r.Workspace = strings.TrimSpace(r.Workspace)
	r.Target = strings.TrimSpace(r.Target)
	r.Model = strings.TrimSpace(r.Model)
	r.Permission = strings.TrimSpace(r.Permission)
	if r.Mode == "" {
		r.Mode = LaunchNew
	}
	if r.Workspace != "" {
		if abs, err := filepath.Abs(r.Workspace); err == nil {
			r.Workspace = abs
		}
	}
	if r.Mode == LaunchSession {
		if canon, err := session.ValidateName(r.Target); err == nil {
			r.Target = canon
		}
	}
	return r
}

// validate mirrors ajent's own flag rules: an existing workspace directory,
// a known mode, a target for resume (bare --resume opens a terminal picker
// and is never spawned), a valid session name, and at most one permission
// flag.
func (r LaunchRequest) validate() error {
	r = r.normalized()
	if r.Workspace == "" {
		return invalidLaunch("workspace is required")
	}
	fi, err := os.Stat(r.Workspace)
	if err != nil {
		return invalidLaunch("workspace %s: %v", r.Workspace, err)
	} else if !fi.IsDir() {
		return invalidLaunch("workspace %s is not a directory", r.Workspace)
	}
	if !slices.Contains(launchModes, r.Mode) {
		return invalidLaunch("unknown mode %q; want new, resume, continue or session", r.Mode)
	}
	switch r.Mode {
	case LaunchResume:
		if r.Target == "" {
			return invalidLaunch("resume needs a target id or name; bare --resume opens a terminal picker and is never spawned")
		}
	case LaunchSession:
		if _, err := session.ValidateName(r.Target); err != nil {
			return invalidLaunch("%v", err)
		}
	}
	if r.Permission != "" && !slices.Contains(launchPermissions, r.Permission) {
		return invalidLaunch("unknown permission %q; want one of %s",
			r.Permission, strings.Join(launchPermissions, ", "))
	}
	return nil
}

// argv builds the child command line: serve mode plus the mode, model and
// permission flags the request names.
func (r LaunchRequest) argv(bin string) []string {
	r = r.normalized()
	out := []string{bin, "--serve"}
	switch r.Mode {
	case LaunchResume:
		out = append(out, "--resume", r.Target)
	case LaunchContinue:
		out = append(out, "--continue")
	case LaunchSession:
		out = append(out, "--session", r.Target)
	}
	if r.Model != "" {
		out = append(out, "--model", r.Model)
	}
	switch r.Permission {
	case PermReadOnly:
		out = append(out, "--read-only")
	case PermAllowAuto:
		out = append(out, "--allow-auto")
	case PermAllowAutowrite:
		out = append(out, "--allow-autowrite")
	case PermAllowAll:
		out = append(out, "--allow-all")
	}
	return out
}

// summary renders the argv a listing shows: the flags after the binary.
func (r LaunchRequest) summary() string {
	return strings.Join(r.argv("ajent")[1:], " ")
}

// ChildRecord is the persisted fact set for one ajent process swarm spawned.
// Exit fields stay zero while the child runs; ExitCode is negative when a
// signal ended it.
type ChildRecord struct {
	ID        int64
	PID       int
	SessionID string
	Workspace string
	Argv      string
	LogPath   string
	StartedAt time.Time
	ExitedAt  time.Time
	ExitCode  *int
	ExitNote  string
	LogTail   string
}

// ChildStore persists children across service restarts, so a restart can
// re-adopt running ones and exited ones keep their exit facts.
type ChildStore interface {
	CreateChild(ctx context.Context, rec ChildRecord) (int64, error)
	UpdateChild(ctx context.Context, rec ChildRecord) error
	Children(ctx context.Context) ([]ChildRecord, error)
}
