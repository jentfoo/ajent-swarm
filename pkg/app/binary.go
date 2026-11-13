package app

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// probeTimeout bounds the ajent --version check at startup.
const probeTimeout = 5 * time.Second

// locateAjent resolves the binary path and verifies it answers --version,
// returning the reported version so a missing or ancient binary fails loudly
// before any session launches.
func locateAjent(ctx context.Context, flagValue string) (path string, version string, err error) {
	bin := flagValue
	if bin == "" {
		bin, err = exec.LookPath("ajent")
		if err != nil {
			return "", "", errors.New("ajent binary not found in PATH; pass --ajent-bin")
		}
	} else if _, err = exec.LookPath(bin); err != nil {
		return "", "", fmt.Errorf("--ajent-bin %s: %w", bin, err)
	}

	pctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, err := exec.CommandContext(pctx, bin, "--version").Output()
	if err != nil {
		return "", "", fmt.Errorf("ajent binary check %s --version: %w", bin, err)
	}
	version = parseVersionLine(string(out))
	if version == "" {
		return "", "", fmt.Errorf("ajent binary %s printed no usable --version output (%q)",
			bin, strings.TrimSpace(string(out)))
	}
	return bin, version, nil
}

// parseVersionLine takes the trailing token of ajent's first output line,
// e.g. "ajent version v0.1.5".
func parseVersionLine(out string) string {
	line, _, _ := strings.Cut(out, "\n")
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	return fields[len(fields)-1]
}
