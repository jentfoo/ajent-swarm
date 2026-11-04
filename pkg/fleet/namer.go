package fleet

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode"
)

// Session auto-titling: when a session commits its first typed prompt, one
// tiny ajent run labels it. The label lands in swarm's own title store keyed
// by session id, so ajent session names and resume targets are never touched.
// Every tracked session names this way — terminal-started ones included — but
// an existing stored title wins: renames from any surface are never clobbered.
// Titling is best effort and never retried.
const (
	namerWait      = 2 * time.Minute // one-shot budget: model latency dominates
	namerPromptMax = 2000            // runes of the start prompt shown to the namer

	titleSystem = "You name coding agent sessions. Answer with a short human-readable" +
		" title of at most five words and nothing else. No explanation, no quotes."

	// maxTitleLabelRunes keeps one title comfortably inside tight listing rows;
	// the store's own cap is wider and clips after us anyway.
	maxTitleLabelRunes = 48
)

// maybeNameSession schedules the one titling attempt for an unnamed session
// that just committed its first typed prompt. Terminal-started sessions name
// too: the label lives in swarm's own store, so ajent itself stays untouched.
func (m *Manager) maybeNameSession(a *sessionActor) {
	if m.bin == "" || m.noNaming {
		return
	}
	m.mu.Lock()
	if _, tried := m.named[a.key.sessionID]; tried {
		m.mu.Unlock()
		return
	}
	v := a.view
	if v == nil || v.firstPrompt == "" {
		m.mu.Unlock()
		return
	}
	// an existing title wins: a rename from any surface is never overwritten
	if m.titles[a.key.sessionID] != "" {
		m.named[a.key.sessionID] = struct{}{}
		m.mu.Unlock()
		return
	}
	m.named[a.key.sessionID] = struct{}{}
	prompt := v.firstPrompt
	sessionID := a.key.sessionID
	m.mu.Unlock()

	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		if err := m.autoName(sessionID, prompt); err != nil {
			m.log.Debug("session titling skipped", "session", sessionID, "err", err)
		}
	}()
}

// autoName runs the labeler and stores its answer as the session's display
// title. The session's control connection is never touched: ajent names stay
// clean for resume.
func (m *Manager) autoName(sessionID, startPrompt string) error {
	ctx, cancel := context.WithTimeout(m.storeCtx, namerWait)
	defer cancel()

	title, err := m.sessionTitleFor(ctx, startPrompt)
	if err != nil {
		return err
	}
	// tight listing rows: clip the label before it ever reaches the store
	if err := m.SetTitle(ctx, sessionID, clipRunes(title, maxTitleLabelRunes)); err != nil {
		return fmt.Errorf("title not stored: %w", err)
	}
	m.log.Info("session titled from its first prompt", "session", sessionID, "title", title)
	return nil
}

// sessionTitleFor asks a one-shot ajent run for the label. A configured
// titling model rides along; when the run fails with it, the setting drops
// back to the default (each session's own model) for this naming and beyond.
// Tools stay off via --no-tools and the scratch working directory keeps any
// stray output away from real workspaces.
func (m *Manager) sessionTitleFor(ctx context.Context, startPrompt string) (string, error) {
	dir, err := os.MkdirTemp("", "swarm-name-")
	if err != nil {
		return "", fmt.Errorf("namer scratch dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	prompt := fmt.Sprintf(
		"A coding agent session started with this request:\n\n%s\n\n"+
			"Reply with a short title for that session, at most five words.",
		clipRunes(startPrompt, namerPromptMax),
	)

	if model := m.TitleModel(); model != "" {
		title, err := runNamer(ctx, m.bin, dir, prompt, model)
		if err == nil {
			return title, nil
		}
		// the model is gone or unusable: switch to the default, then name with
		// it right away so this session still gets a label
		m.log.Info("titling model unavailable; using the session model", "model", model, "err", err)
		if clearErr := m.SetTitleModel(ctx, ""); clearErr != nil {
			m.log.Warn("titling model not cleared", "err", clearErr)
		}
	}
	return runNamer(ctx, m.bin, dir, prompt, "")
}

// runNamer executes one one-shot ajent run and sanitizes its answer; model
// selects the labeler's model, empty meaning ajent's own default.
func runNamer(ctx context.Context, bin, dir, prompt, model string) (string, error) {
	args := []string{"-p", prompt, "--system", titleSystem, "--no-tools"}
	if model != "" {
		args = append(args, "--model", model)
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("namer run: %w", err)
	}
	title := sanitizeSessionTitle(string(out))
	if title == "" {
		return "", errors.New("namer produced no usable title")
	}
	return title, nil
}

// sanitizeSessionTitle reduces freeform namer output to a display label: the
// first non-empty line after the last bare markup tag, with whitespace runs
// collapsed. Empty means no usable answer.
func sanitizeSessionTitle(s string) string {
	lines := strings.Split(s, "\n")
	// some models answer the titling prompt with an XML-ish tool-call block
	// despite --no-tools, and the real title sits after that markup
	start := 0
	for i, line := range lines {
		tag := strings.TrimSpace(line)
		if len(tag) > 1 && tag[0] == '<' && tag[len(tag)-1] == '>' &&
			!strings.ContainsFunc(tag[1:len(tag)-1], unicode.IsSpace) {
			start = i + 1
		}
	}
	for _, line := range lines[start:] {
		if fields := strings.Fields(line); len(fields) > 0 {
			return strings.Join(fields, " ")
		}
	}
	return ""
}

// clipRunes bounds s to at most n runes.
func clipRunes(s string, n int) string {
	runes := []rune(strings.TrimSpace(s))
	if len(runes) <= n {
		return strings.TrimSpace(s)
	}
	return string(runes[:n])
}
