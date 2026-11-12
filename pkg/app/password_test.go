package app

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
)

// promptStub points the terminal seams at scripted answers, restoring both
// afterwards. Each read consumes the next answer.
func promptStub(t *testing.T, terminal bool, answers ...string) {
	t.Helper()

	prevTerm, prevRead := stdinIsTerminal, readPasswordLine
	stdinIsTerminal = func() bool { return terminal }
	next := 0
	readPasswordLine = func(int) ([]byte, error) {
		if next >= len(answers) {
			return nil, errors.New("no scripted answer left")
		}
		answer := answers[next]
		next++
		return []byte(answer), nil
	}
	t.Cleanup(func() { stdinIsTerminal, readPasswordLine = prevTerm, prevRead })
}

// setEnv sets key to value for the test, restoring the previous state. An
// empty value removes the variable.
func setEnv(t *testing.T, key, value string) {
	t.Helper()

	prev, had := os.LookupEnv(key)
	if value == "" {
		require.NoError(t, os.Unsetenv(key))
	} else {
		require.NoError(t, os.Setenv(key, value))
	}
	t.Cleanup(func() {
		if had {
			_ = os.Setenv(key, prev)
			return
		}
		_ = os.Unsetenv(key)
	})
}

func TestResolveLoginPassword(t *testing.T) {
	// not parallel: swaps the terminal seams and process environment

	t.Run("prompt_match", func(t *testing.T) {
		promptStub(t, true, "hunter2", "hunter2")
		var out bytes.Buffer

		pw, err := resolveLoginPassword(&out)
		require.NoError(t, err)
		assert.Equal(t, "hunter2", pw)
		assert.Contains(t, out.String(), "Set login password: ")
		assert.Contains(t, out.String(), "Confirm password: ")
	})

	t.Run("prompt_mismatch_retries_then_succeeds", func(t *testing.T) {
		promptStub(t, true, "a", "b", "c", "c")
		var out bytes.Buffer

		pw, err := resolveLoginPassword(&out)
		require.NoError(t, err)
		assert.Equal(t, "c", pw)
		assert.Contains(t, out.String(), "passwords do not match")
	})

	t.Run("prompt_retries_empty_entries", func(t *testing.T) {
		promptStub(t, true, "", "", "hunter2", "hunter2")
		var out bytes.Buffer

		pw, err := resolveLoginPassword(&out)
		require.NoError(t, err)
		assert.Equal(t, "hunter2", pw)
		assert.Contains(t, out.String(), "password must not be empty")
	})

	t.Run("prompt_retries_too_long_entries", func(t *testing.T) {
		long := strings.Repeat("x", auth.MaxPasswordBytes+1)
		promptStub(t, true, long, long, "ok", "ok")
		var out bytes.Buffer

		pw, err := resolveLoginPassword(&out)
		require.NoError(t, err)
		assert.Equal(t, "ok", pw)
		assert.Contains(t, out.String(), "at most 72 bytes")
	})

	t.Run("prompt_exhausts_attempts", func(t *testing.T) {
		promptStub(t, true, "a", "b", "c", "d", "e", "f")
		var out bytes.Buffer

		_, err := resolveLoginPassword(&out)
		require.ErrorContains(t, err, "after 3 attempts")
	})

	t.Run("prompt_read_error_fails_fast", func(t *testing.T) {
		promptStub(t, true)
		var out bytes.Buffer

		_, err := resolveLoginPassword(&out)
		require.ErrorContains(t, err, "read password: ")
	})

	t.Run("environment_when_not_a_terminal", func(t *testing.T) {
		setEnv(t, PasswordEnv, "hunter2")
		promptStub(t, false)

		pw, err := resolveLoginPassword(&bytes.Buffer{})
		require.NoError(t, err)
		assert.Equal(t, "hunter2", pw)
		assert.Empty(t, os.Getenv(PasswordEnv))
	})

	t.Run("environment_consumed_on_prompt_path", func(t *testing.T) {
		setEnv(t, PasswordEnv, "from-env")
		promptStub(t, true, "hunter2", "hunter2")

		pw, err := resolveLoginPassword(&bytes.Buffer{})
		require.NoError(t, err)
		assert.Equal(t, "hunter2", pw)
		assert.Empty(t, os.Getenv(PasswordEnv))
	})

	t.Run("missing_environment_fails_without_prompting", func(t *testing.T) {
		setEnv(t, PasswordEnv, "")
		promptStub(t, false, "never-read")

		_, err := resolveLoginPassword(&bytes.Buffer{})
		require.ErrorContains(t, err, "non-empty "+PasswordEnv)
	})

	t.Run("environment_too_long_rejected", func(t *testing.T) {
		setEnv(t, PasswordEnv, strings.Repeat("x", auth.MaxPasswordBytes+1))
		promptStub(t, false)

		_, err := resolveLoginPassword(&bytes.Buffer{})
		require.ErrorContains(t, err, PasswordEnv+": password must be at most 72 bytes")
	})

	t.Run("environment_boundary_length_accepted", func(t *testing.T) {
		setEnv(t, PasswordEnv, strings.Repeat("x", auth.MaxPasswordBytes))
		promptStub(t, false)

		pw, err := resolveLoginPassword(&bytes.Buffer{})
		require.NoError(t, err)
		assert.Len(t, pw, auth.MaxPasswordBytes)
	})
}
