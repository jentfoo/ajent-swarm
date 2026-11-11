package fleet

import (
	"context"
	"time"

	"github.com/jentfoo/ajent/pkg/command"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/session"
)

// Park bounds: both idle gates share one fleet-busy rule, the park window is
// just shorter than the scheduler's job hold, and the cap bounds a burst of
// queue presses.
const (
	parkIdleWindow = time.Minute
	maxParked      = 32
)

// parkedSubmit is one prompt line parked until the fleet quiets down.
type parkedSubmit struct {
	params   ctl.SubmitParams
	queuedAt time.Time
}

type msgParkSubmit struct {
	params ctl.SubmitParams
	reply  chan error
}

type msgParkRecall struct{ reply chan cmdParkRecall }

// cmdParkRecall carries the popped parked prompt, ok is false when the park
// list was empty.
type cmdParkRecall struct {
	params ctl.SubmitParams
	ok     bool
	err    error
}

// msgParkDue is the park timer's tick.
type msgParkDue struct{}

// handleParkSubmit parks one prompt line for the fleet's next quiet point.
func (a *sessionActor) handleParkSubmit(msg msgParkSubmit) {
	if !a.ready() {
		msg.reply <- notReady()
		return
	}
	if len(a.parked) >= maxParked {
		msg.reply <- ctl.Errf(ctl.CodeBadRequest, "too many prompts queued for this session")
		return
	}
	msg.reply <- nil // the park itself cannot fail past this point
	a.parked = append(a.parked, parkedSubmit{params: msg.params, queuedAt: time.Now()})
	a.refreshStatus()
	a.schedulePark()
	// a session's first prompt can sit parked for its idle point: name from it
	// now instead of waiting for the run that may be minutes away
	if a.view.firstPrompt == "" {
		if line := command.ParseLine(msg.params.Line); line.Kind == command.KindPrompt {
			a.mgr.maybeNameSessionFrom(a, line.Rest)
		}
	}
}

// handleParkRecall pops the newest parked prompt for edit-and-resubmit.
func (a *sessionActor) handleParkRecall(msg msgParkRecall) {
	if !a.ready() {
		msg.reply <- cmdParkRecall{err: notReady()}
		return
	}
	if len(a.parked) == 0 {
		msg.reply <- cmdParkRecall{}
		return
	}
	last := a.parked[len(a.parked)-1]
	a.parked = a.parked[:len(a.parked)-1]
	msg.reply <- cmdParkRecall{params: last.params, ok: true}
	a.refreshStatus()
	a.schedulePark()
}

// schedulePark arms the flush timer off the parked lines' quiet target: the
// oldest park, the fleet's busy moment or a release or reconnect floor,
// whichever is latest, plus the window. Only the actor goroutine calls this.
func (a *sessionActor) schedulePark() {
	if a.parkTimer != nil {
		a.parkTimer.Stop()
		a.parkTimer = nil
	}
	if len(a.parked) == 0 || a.view == nil {
		return
	}
	a.parkTimer = time.AfterFunc(time.Until(a.parkQuietAt()), a.parkWake)
}

// parkQuietAt is the earliest moment a flush may run: every busy moment must
// age past the park window first, whether observed across the fleet, hidden by
// a reconnect or caused by an earlier release here. The shared rule behind
// LastBusyAt covers this session too.
func (a *sessionActor) parkQuietAt() time.Time {
	target := a.parked[0].queuedAt
	if at := a.mgr.LastBusyAt(); at.After(target) {
		target = at
	}
	if a.busyFloor.After(target) {
		target = a.busyFloor
	}
	return target.Add(a.mgr.parkWindow)
}

// parkWake lands the timer tick on the actor mailbox; a stopped actor drops it.
func (a *sessionActor) parkWake() {
	select {
	case a.mailbox <- msgParkDue{}:
	case <-a.ctx.Done():
	}
}

// handleParkDue releases the oldest parked line once the whole fleet has been
// quiet for the park window; everything behind it waits out a fresh idle
// point, so released turns never pile onto one quiet moment. A still-busy
// fleet re-arms, an unreachable one waits for the reconnect (which raises the
// busy floor), and a refused line retries after its own fresh window.
func (a *sessionActor) handleParkDue() {
	a.parkTimer = nil
	if len(a.parked) == 0 || !a.ready() {
		return
	}
	if time.Now().Before(a.parkQuietAt()) {
		a.schedulePark()
		return
	}
	first := a.parked[0]
	if err := a.submitUpstream(first.params); err != nil {
		a.log.Warn("parked prompt refused at its idle point", "err", err, "parked", len(a.parked))
	} else {
		a.recordRecallSubmit(first.params)
		a.parked = a.parked[1:]
		a.refreshStatus()
	}
	// a release's turn is not observable yet, so it counts as busy until the
	// facts catch up; a refused line retries past the same fresh window
	a.busyFloor = time.Now()
	a.schedulePark()
}

// clearParked drops every parked prompt and disarms the timer.
func (a *sessionActor) clearParked() {
	a.parked = nil
	if a.parkTimer != nil {
		a.parkTimer.Stop()
		a.parkTimer = nil
	}
}

// parkPreview returns the oldest parked prompt's display text, secrets
// withheld, empty when no parked line is a plain prompt.
func parkPreview(rows []parkedSubmit) string {
	if len(rows) == 0 {
		return ""
	}
	line := command.ParseLine(rows[0].params.Line)
	if line.Kind != command.KindPrompt {
		return ""
	}
	if session.HasSecretPrefix(recallSecretPrefix, line.Rest) {
		return "secret prompt"
	}
	return digestText(line.Rest)
}

// parkRows names every parked prompt for the snapshot payload, oldest first.
// Only plain prompts travel: shell and slash lines queued without a pendingId
// have no optimistic row to resolve, and secrets redact to empty text.
func parkRows(rows []parkedSubmit) []ctl.QueueRow {
	out := make([]ctl.QueueRow, 0, len(rows))
	for _, row := range rows {
		if row.params.PendingID == "" {
			continue
		}
		line := command.ParseLine(row.params.Line)
		if line.Kind != command.KindPrompt {
			continue
		}
		text := ""
		if !session.HasSecretPrefix(recallSecretPrefix, line.Rest) {
			text = digestText(line.Rest)
		}
		out = append(out, ctl.QueueRow{ID: row.params.PendingID, Text: text})
	}
	return out
}

// serveState pairs the reconciled view with swarm's own park facts, the shape
// init frames and snapshot polls both carry.
func (a *sessionActor) serveState() SessionState {
	st := SessionState{State: a.view.snapshot()}
	if len(a.parked) > 0 {
		st.ParkedRows = parkRows(a.parked)
	}
	return st
}

// QueueSubmit parks one prompt line on the session until the whole fleet has
// been quiet for the park window, then submits it as typed. Lines record into
// the workspace recall mirror once they land.
func (m *Manager) QueueSubmit(ctx context.Context, sessionID string, params ctl.SubmitParams) error {
	a := m.route(sessionID)
	if a == nil {
		return ErrUnknownSession
	}
	err, _ := mailboxCommand(ctx, a, func(reply chan error) actorMsg {
		return msgParkSubmit{params: params, reply: reply}
	})
	return err
}

// QueueRecall pops the newest parked prompt for edit-and-resubmit. ok is
// false when nothing is parked.
func (m *Manager) QueueRecall(ctx context.Context, sessionID string) (ctl.SubmitParams, bool, error) {
	a := m.route(sessionID)
	if a == nil {
		return ctl.SubmitParams{}, false, ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdParkRecall) actorMsg {
		return msgParkRecall{reply: reply}
	})
	if err != nil {
		return ctl.SubmitParams{}, false, err
	}
	return res.params, res.ok, res.err
}
