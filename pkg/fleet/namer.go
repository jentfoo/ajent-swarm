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

	"github.com/jentfoo/ajent/pkg/client"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// Session auto-naming: when a swarm-spawned session commits its first typed
// prompt while still unnamed, one tiny ajent run labels it. The label lands
// through the session's own `/session` command, so every surface (picker,
// listing, rail) learns it from the regular rename event with no new wire
// shape. Naming is best effort and never retried.
const (
	namerWait      = 2 * time.Minute // one-shot budget: model latency dominates
	namerPromptMax = 2000            // runes of the start prompt shown to the namer

	namerSystem = "You name coding agent sessions. Answer with a short kebab-case " +
		"name of at most five words and nothing else. No explanation, no quotes."

	renameCommand = "/session "
)

// msgRename routes one auto-name onto the session's connection.
type msgRename struct {
	name  string
	reply chan error
}

// handleRename submits /session when the session is still unnamed; a name it
// gained meanwhile wins and the rename quietly does nothing.
func (a *sessionActor) handleRename(msg msgRename) {
	if a.conn == nil || a.view == nil {
		msg.reply <- errors.New("session is not connected")
		return
	}
	if a.view.session.Name != "" {
		msg.reply <- nil
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- err // seat-held names its holder
		return
	}
	cctx, cancel := context.WithTimeout(a.ctx, client.CallWait)
	defer cancel()
	msg.reply <- a.conn.Submit(cctx, ctl.SubmitParams{Line: renameCommand + msg.name})
}

// maybeNameSession schedules the one naming attempt for an unnamed session
// that just committed its first typed prompt. Owned sessions only: renaming
// someone else's attached session is never swarm's call.
func (m *Manager) maybeNameSession(a *sessionActor) {
	if m.bin == "" || m.noNaming || !m.ownedInstance(a.inst) {
		return
	}
	m.mu.Lock()
	if _, tried := m.named[a.key.sessionID]; tried {
		m.mu.Unlock()
		return
	}
	v := a.view
	if v == nil || v.session.Name != "" || v.firstPrompt == "" {
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
			m.log.Debug("session naming skipped", "session", sessionID, "err", err)
		}
	}()
}

// autoName runs the labeler and applies its answer through the mailbox.
func (m *Manager) autoName(sessionID, startPrompt string) error {
	ctx, cancel := context.WithTimeout(m.storeCtx, namerWait)
	defer cancel()

	name, err := m.sessionNameFor(ctx, startPrompt)
	if err != nil {
		return err
	}
	a := m.route(sessionID)
	if a == nil {
		return errors.New("session is no longer tracked")
	}
	err, _ = mailboxCall(ctx, a, func(reply chan error) actorMsg {
		return msgRename{name: name, reply: reply}
	})
	if err != nil {
		return fmt.Errorf("rename refused: %w", err)
	}
	m.log.Info("session named from its first prompt", "session", sessionID, "name", name)
	return nil
}

// sessionNameFor asks a one-shot ajent run for the label. The scratch working
// directory keeps any stray tool use away from real workspaces.
func (m *Manager) sessionNameFor(ctx context.Context, startPrompt string) (string, error) {
	dir, err := os.MkdirTemp("", "swarm-name-")
	if err != nil {
		return "", fmt.Errorf("namer scratch dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	prompt := fmt.Sprintf(
		"A coding agent session started with this request:\n\n%s\n\n"+
			"Reply with a kebab-case name for that session, at most five words.",
		clipRunes(startPrompt, namerPromptMax),
	)
	cmd := exec.CommandContext(ctx, m.bin, "-p", prompt, "--system", namerSystem, "--read-only")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("namer run: %w", err)
	}
	name := sanitizeSessionName(string(out))
	if name == "" {
		return "", errors.New("namer produced no usable name")
	}
	return name, nil
}

// sanitizeSessionName turns freeform model output into a valid session name:
// the first line, lowercased, with every run of disallowed runes collapsed to
// one dash. Empty means the answer was unusable.
func sanitizeSessionName(s string) string {
	s = strings.TrimSpace(strings.SplitN(s, "\n", 2)[0])
	var b strings.Builder
	dashed := false
	for _, r := range s {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(unicode.ToLower(r))
			dashed = false
		default:
			if !dashed && b.Len() > 0 {
				b.WriteByte('-')
				dashed = true
			}
		}
		if b.Len() >= maxNameRunes {
			break
		}
	}
	return strings.Trim(b.String(), "-.")
}

// clipRunes bounds s to at most n runes.
func clipRunes(s string, n int) string {
	runes := []rune(strings.TrimSpace(s))
	if len(runes) <= n {
		return strings.TrimSpace(s)
	}
	return string(runes[:n])
}

const maxNameRunes = 48 // comfortably under ajent's own name cap
