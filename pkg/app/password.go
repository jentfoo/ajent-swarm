package app

import (
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/term"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
)

// PasswordEnv carries a resolved login password through headless starts and
// the --daemon handoff, startup consumes and unsets it.
const PasswordEnv = "AJENT_SWARM_PASSWORD"

// promptAttempts bounds the set-and-confirm loop before startup fails.
const promptAttempts = 3

var (
	// stdinIsTerminal reports whether an interactive prompt can run. A var so
	// tests drive both flows without a TTY.
	stdinIsTerminal = func() bool { return term.IsTerminal(int(os.Stdin.Fd())) }
	// readPasswordLine reads one password with echo disabled, mirroring
	// term.ReadPassword's fd signature. A var so tests script the answers.
	readPasswordLine = term.ReadPassword
)

// resolveLoginPassword returns the value --password applies: a twice-asked
// prompt on a terminal, otherwise PasswordEnv for headless starts and scripts.
// The environment variable is consumed either way, so an inherited handoff
// value never outlives startup.
func resolveLoginPassword(stderr io.Writer) (string, error) {
	handoff := os.Getenv(PasswordEnv)
	_ = os.Unsetenv(PasswordEnv)

	if !stdinIsTerminal() {
		if handoff == "" {
			return "", fmt.Errorf("needs a terminal to prompt or a non-empty %s", PasswordEnv)
		}
		if err := checkLoginPassword(handoff); err != nil {
			return "", fmt.Errorf("%s: %w", PasswordEnv, err)
		}
		return handoff, nil
	}
	return promptNewPassword(stderr)
}

// promptNewPassword asks for and confirms a new password with echo disabled,
// retrying mismatches a bounded number of times before giving up.
func promptNewPassword(stderr io.Writer) (string, error) {
	for attempt := 1; ; attempt++ {
		if attempt > promptAttempts {
			return "", fmt.Errorf("password entry failed after %d attempts", promptAttempts)
		}
		first, err := askPassword(stderr, "Set login password: ")
		if err != nil {
			return "", err
		}
		confirm, err := askPassword(stderr, "Confirm password: ")
		if err != nil {
			return "", err
		}

		var problem error
		if first != confirm {
			problem = errors.New("passwords do not match")
		} else {
			problem = checkLoginPassword(first)
		}
		if problem == nil {
			return first, nil
		}
		_, _ = fmt.Fprintf(stderr, "%v\n", problem)
	}
}

// askPassword prints prompt and reads one line with echo disabled, restoring
// the newline the terminal suppressed.
func askPassword(stderr io.Writer, prompt string) (string, error) {
	if _, err := fmt.Fprint(stderr, prompt); err != nil {
		return "", fmt.Errorf("write prompt: %w", err)
	}
	line, err := readPasswordLine(int(os.Stdin.Fd()))
	if err != nil {
		return "", fmt.Errorf("read password: %w", err)
	}
	_, _ = fmt.Fprintln(stderr)
	return string(line), nil
}

// checkLoginPassword validates a proposed login password.
func checkLoginPassword(pw string) error {
	if pw == "" {
		return errors.New("password must not be empty")
	}
	if len(pw) > auth.MaxPasswordBytes {
		return fmt.Errorf("password must be at most %d bytes", auth.MaxPasswordBytes)
	}
	return nil
}
