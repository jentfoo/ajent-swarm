package sched

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	"github.com/jentfoo/ajent-swarm/pkg/store"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// Run execution tuning. The submit window covers a session that is still
// starting and a resumed one whose old dialog is about to clear; a refusal
// after it records the failure instead of hanging.
const (
	framesQueue = 256
	maxRunError = 8 << 10 // launch failures carry log tails; keep rows bounded

	triggerCommandTimeout = 5 * time.Minute  // a hung gate cannot wedge the loop
	triggerOutputMax      = 4 << 10          // gate output prepended to the prompt
	stopCallWait          = 30 * time.Second // teardown bound: Stop never hangs on a wedged runner
)

// maxGateNote bounds the exit detail inside a skip reason.
const maxGateNote = 200

// Retry cadences are vars so tests can shrink them below their production
// values while keeping the retry structure intact.
var (
	submitWait     = 15 * time.Second
	submitEvery    = 500 * time.Millisecond
	resubscribeGap = 250 * time.Millisecond
)

// idleWindow is how long the fleet must have seen no agent activity before a
// run-when-idle job may fire.
const idleWindow = 10 * time.Minute

// Runner is the fleet surface every run goes through: spawn (or resume) a
// serve session, drive it over the control socket and watch its stream. A
// zero LastBusyAt reports a fleet with no known agent activity.
type Runner interface {
	Launch(ctx context.Context, req fleet.LaunchRequest) (fleet.LaunchResult, error)
	Submit(ctx context.Context, sessionID string, params ctl.SubmitParams) error
	ToolsSet(ctx context.Context, sessionID string, names []string) (ctl.ToolsSetResult, error)
	StopSession(ctx context.Context, sessionID string) error
	Subscribe(sessionID string, deliver func([]byte), onDrop func()) (*fleet.Subscription, error)
	Unsubscribe(sub *fleet.Subscription)
	LastBusyAt() time.Time
}

// ensure the manager keeps satisfying the runner surface.
var _ Runner = (*fleet.Manager)(nil)

// execute drives one claimed run to its terminal row, tearing the session
// down afterwards unless keep_alive says otherwise. Runs detached from callers
// so a slow launch never blocks the trigger loop.
func (s *Scheduler) execute(run store.Run, j store.Job) {
	defer s.wg.Done()

	ctx := s.baseCtx

	prompt := j.Prompt
	if gate := strings.TrimSpace(j.TriggerCommand); gate != "" {
		out, code, err := runTriggerCommand(ctx, strings.TrimSpace(j.Workspace), gate)
		passed, why := gatePassed(j.TriggerOn, code, err)
		if !passed { // the schedule already advanced; history records the veto
			s.finish(run, j, store.RunSkipped, why)
			return
		}
		if prompt != "" {
			prompt = prependGateOutput(gate, code, out, prompt)
		}
	}

	res, err := s.runner.Launch(ctx, fleet.LaunchRequest{
		Workspace:     j.Workspace,
		Mode:          fleet.LaunchMode(j.SpawnMode),
		Target:        j.SessionTarget,
		Model:         j.Model,
		Permission:    j.Permission,
		CommandPrefix: j.CommandPrefix,
	})
	if err != nil {
		s.finish(run, j, store.RunFailed, err.Error())
		return
	}
	run.SessionID = res.SessionID
	run.Prompt = prompt // the gate's output rides the stored row too
	if err := s.store.UpdateRun(s.ctx, run); err != nil {
		s.log.Warn("run session not persisted", "run", run.ID, "err", err)
	}

	// a custom set reshapes the fresh session before any prompt lands: ajent's
	// tools.set is a free replacement until the first dispatched prompt. A set
	// that never applies fails the run like a refused submit, since the job
	// asked for a shape the session does not have.
	if j.ToolsCustom {
		if err := s.applyTools(ctx, run.SessionID, parseToolList(j.Tools)); err != nil {
			s.finish(run, j, store.RunFailed, err.Error())
			return
		}
	}

	if prompt == "" { // a launcher job: serving is the whole deliverable
		s.finish(run, j, store.RunOK, "")
		return
	}

	frames := make(chan []byte, framesQueue)
	watching := make(chan struct{})
	go s.pump(res.SessionID, frames, watching)
	defer close(watching)

	if err = s.submitPrompt(ctx, run); err != nil {
		s.finish(run, j, store.RunFailed, err.Error())
		return
	}

	status := s.awaitSettled(run, j, frames)
	s.finish(run, j, status.status, status.err)
}

// pump keeps one live subscription on the session's stream for as long as
// watching lasts: it re-subscribes after an overflow drop and retries while no
// actor tracks the session yet. Frames flow into out; drops need no signal,
// because every fresh subscription greets with a reconciling init.
func (s *Scheduler) pump(sessionID string, out chan<- []byte, done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		default:
		}

		dropped := make(chan struct{}, 1)
		sub, err := s.runner.Subscribe(sessionID,
			func(b []byte) { // a wedged watcher loses the subscription fail-open
				select {
				case out <- b:
				default:
				}
			},
			func() {
				select {
				case dropped <- struct{}{}:
				default:
				}
			})
		if err != nil {
			select {
			case <-done:
				return
			case <-time.After(resubscribeGap):
			}
			continue
		}

		select {
		case <-done:
			s.runner.Unsubscribe(sub)
			return
		case <-dropped: // the queue overflowed; rebuild on a fresh subscription
			s.runner.Unsubscribe(sub)
		}
	}
}

// controlRetry drives one launch-time control call through the bounded retry
// window submitPrompt and applyTools share: a still-starting session refuses
// briefly, so retriable refusals wait theirs out while real rejections fail at
// once. A refusal after the window lands in history instead of hanging.
func (s *Scheduler) controlRetry(ctx context.Context, verb string, call func() error) error {
	deadline := time.Now().Add(submitWait)
	var last error
	for {
		err := call()
		if err == nil {
			return nil
		}
		last = err

		switch {
		case ctx.Err() != nil:
			return fmt.Errorf("%s cancelled: %w", verb, ctx.Err())
		case time.Now().After(deadline):
			return fmt.Errorf("%s refused after retrying for %s: %w",
				verb, submitWait, last)
		case retriable(err):
			select { // brief pause between attempts
			case <-ctx.Done():
				return fmt.Errorf("%s cancelled: %w", verb, ctx.Err())
			case <-time.After(submitEvery):
			}
		default:
			return fmt.Errorf("%s refused: %s", verb, err.Error())
		}
	}
}

// submitPrompt delivers the run's prompt with its synthetic pendingId.
func (s *Scheduler) submitPrompt(ctx context.Context, run store.Run) error {
	return s.controlRetry(ctx, "submit", func() error {
		return s.runner.Submit(ctx, run.SessionID, ctl.SubmitParams{
			Line:      run.Prompt,
			PendingID: pendingID(run),
		})
	})
}

// applyTools reshapes one launched session's enabled tool set. Unknown names
// are ignored upstream, so a workspace missing a tool degrades to the rest of
// the set; resumed or kept-alive sessions past their first prompt follow the
// widen-only rule.
func (s *Scheduler) applyTools(ctx context.Context, sessionID string, names []string) error {
	return s.controlRetry(ctx, "tools", func() error {
		_, err := s.runner.ToolsSet(ctx, sessionID, names)
		return err
	})
}

// retriable reports whether one submit refusal may clear on its own: a session
// that is still starting or reconnecting, and a queue worth retrying.
func retriable(err error) bool {
	if errors.Is(err, fleet.ErrUnknownSession) {
		return true // the actor has not attached yet
	}
	var ce *ctl.Error
	if !errors.As(err, &ce) {
		return false
	}
	switch ce.Code {
	case ctl.CodeUnavailable, ctl.CodeBusy:
		return true
	default:
		return false
	}
}

// watchState is the run watcher's reconciled view of one session.
type watchState struct {
	pid string // the run's pendingId

	landed   bool // a committed entry carries our pendingId in its queueIds
	idle     bool // the prompt's rest state flipped true after landing
	dialogs  int  // open dialogs from the latest init, tracked by events since
	awaiting bool // awaiting_input recorded on the run row
	stopped  bool // the session itself ended
}

// outcome is a terminal watcher conclusion; an empty status keeps waiting.
type outcome struct {
	status string
	err    string
}

// apply folds one raw stream frame into the state, reporting any terminal
// conclusion it implies. persist records transient status flips on the run row.
func (w *watchState) apply(raw []byte, persist func(status string)) outcome {
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &head) != nil {
		return outcome{}
	}

	switch head.Type {
	case fleet.FrameInit: // full replacement: reset the reconciled view
		var f fleet.InitFrame
		if err := json.Unmarshal(raw, &f); err == nil {
			w.dialogs = len(f.State.Interactions)
			for _, e := range f.Entries { // fold first: a late subscriber's landing
				if landsEntry(e, w.pid) { // lives only in the entry tail
					w.landed = true
				}
			}
			// evaluated after folding so an init carrying both the committed
			// landing and a rest state still concludes the run
			if w.landed && f.State.Idle {
				w.idle = true
			}
		}

	case fleet.FrameEvent:
		var f fleet.EventFrame
		if err := json.Unmarshal(raw, &f); err == nil {
			return w.applyEvent(f.Event, persist)
		}

	case fleet.FrameChild: // swarm lifecycle facts only it knows
		var f fleet.ChildFrame
		if err := json.Unmarshal(raw, &f); err == nil &&
			(f.State == fleet.ChildExited || f.State == fleet.ChildGone) {
			w.stopped = true
		}
	}

	return w.settle(persist)
}

// applyEvent folds one upstream event into the state.
func (w *watchState) applyEvent(ev ctl.Event, persist func(string)) outcome {
	switch ev.Name {
	case ctl.EventEntryAppend:
		var d ctl.EntryData
		if err := ev.Decode(&d); err == nil && landsEntry(d.Entry, w.pid) {
			w.landed = true
		}

	case ctl.EventQueueDropped: // the prompt left the queue without committing
		if !w.landed {
			var d ctl.QueueDroppedData
			if err := ev.Decode(&d); err == nil &&
				slices.ContainsFunc(d.Rows, func(r ctl.QueueRow) bool { return r.ID == w.pid }) {
				return outcome{store.RunFailed,
					fmt.Sprintf("prompt dropped before it ran (cause %s)", orNone(d.Cause))}
			}
		}

	case ctl.EventInteractionPending:
		w.dialogs++

	case ctl.EventInteractionSettled:
		if w.dialogs > 0 {
			w.dialogs--
		}

	case ctl.EventIdle:
		var d ctl.IdleData
		if err := ev.Decode(&d); err == nil && d.Idle && w.landed {
			w.idle = true
		}

	case ctl.EventSessionExit: // always the last event before close
		var d ctl.SessionExitData
		_ = ev.Decode(&d)
		if w.landed { // the prompt's work happened; a clean end completes it
			return outcome{store.RunOK, ""}
		}
		return outcome{store.RunFailed,
			"session exited before the run settled: " + orNone(d.Reason)}
	}

	return w.settle(persist)
}

// settle derives transient status flips and any terminal conclusion from the
// reconciled state.
func (w *watchState) settle(persist func(status string)) outcome {
	if w.stopped && !w.landed {
		return outcome{store.RunFailed, "session ended before it accepted the prompt"}
	}
	switch {
	case w.dialogs > 0 && !w.awaiting: // parked at a tool barrier or question
		w.awaiting = true
		persist(store.RunAwaitingInput)
	case w.dialogs == 0 && w.awaiting:
		w.awaiting = false
		persist(store.RunRunning)
	}
	if w.landed && w.idle && w.dialogs == 0 {
		return outcome{store.RunOK, ""}
	}
	return outcome{}
}

// awaitSettled consumes the run's stream until it concludes or its bounded
// timeout lands. The budget runs from the row's start, so launch time counts.
func (s *Scheduler) awaitSettled(run store.Run, j store.Job, frames <-chan []byte) outcome {
	w := &watchState{pid: pendingID(run)}
	persist := func(status string) {
		run.Status = status
		if err := s.store.UpdateRun(s.ctx, run); err != nil {
			s.log.Warn("run status not persisted", "run", run.ID, "err", err)
		}
	}

	timeout := s.opts.RunTimeoutDefault
	if j.TimeoutMinutes > 0 {
		timeout = time.Duration(j.TimeoutMinutes) * time.Minute
	}
	timer := time.NewTimer(time.Until(run.StartedAt.Add(timeout)))
	defer timer.Stop()

	for {
		select {
		case <-timer.C:
			return outcome{store.RunTimeout, w.timeoutNote()}

		case <-s.baseCtx.Done():
			return outcome{store.RunFailed, interruptedNote}

		case raw := <-frames:
			if o := w.apply(raw, persist); o.status != "" {
				return o
			}
		}
	}
}

// timeoutNote explains what the run was doing when its budget ran out.
func (w *watchState) timeoutNote() string {
	if w.dialogs > 0 || w.awaiting {
		return "parked at an open dialog until the timeout"
	}
	if !w.landed {
		return "session never accepted the prompt before the timeout"
	}
	return "prompt did not settle before the timeout"
}

// landsEntry reports whether one committed entry is our prompt's landing.
func landsEntry(e ctl.Entry, pid string) bool {
	if e.Type != "message" || len(e.Data) == 0 {
		return false
	}
	var data struct {
		QueueIDs []string `json:"queueIds"`
	}
	if json.Unmarshal(e.Data, &data) != nil {
		return false
	}
	return slices.Contains(data.QueueIDs, pid)
}

// orNone renders an empty free-form reason as a word instead of nothing.
func orNone(s string) string {
	if strings.TrimSpace(s) == "" {
		return "no reason given"
	}
	return s
}

// finish records the terminal status, then tears the session down unless the
// job keeps it alive. Bookkeeping detaches from shutdown cancellation so a
// stopping service still writes what it knows.
func (s *Scheduler) finish(run store.Run, j store.Job, status string, note string) {
	fin := time.Now()
	run.Status = status
	run.FinishedAt = &fin
	run.Error = note[:min(len(note), maxRunError)]
	if err := s.store.UpdateRun(s.ctx, run); err != nil {
		s.log.Warn("run outcome not persisted", "run", run.ID, "err", err)
	}
	s.log.Info("run finished", "job", j.ID, "session", run.SessionID,
		"status", status)

	if !s.stopAfter(run) {
		return
	}
	stopCtx, cancel := context.WithTimeout(s.ctx, stopCallWait)
	defer cancel()
	if err := s.runner.StopSession(stopCtx, run.SessionID); err != nil {
		s.log.Warn("run session could not be stopped", "session",
			run.SessionID, "err", err)
	}
}

// stopAfter reports whether a finished run tears its session down: only runs
// that launched one, for jobs without keep-alive (or whose job went away).
func (s *Scheduler) stopAfter(run store.Run) bool {
	if run.JobID == nil || run.SessionID == "" {
		return false // nothing spawned, nothing to tear down
	}
	j, err := s.store.JobByID(s.ctx, *run.JobID)
	if err != nil {
		return true // a deleted job's session is nobody's to keep alive
	}
	return !j.KeepAlive
}

// runTriggerCommand executes one gate under sh -c with a bounded wait,
// returning its combined output and exit code; an interrupted context or a
// timeout reports the Go error instead. The empty dir inherits swarm's cwd.
func runTriggerCommand(ctx context.Context, dir, command string) (string, int, error) {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), triggerCommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(rctx, "sh", "-c", command)
	if dir != "" { // an optional/legacy empty workspace keeps the inherit
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		code := -1
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		}
		return string(out), code, err
	}
	return string(out), 0, nil
}

// gatePassed compares one gate outcome with the job's chosen policy. A veto
// carries the reason history records.
func gatePassed(policy string, code int, err error) (bool, string) {
	if err != nil && code < 0 { // never exited: cancelled or timed out
		return false, fmt.Sprintf("skipped: trigger command did not finish (%v)", err)
	}
	succeeded := err == nil && code == 0
	switch policy {
	case store.TriggerOnError:
		if succeeded {
			return false, "skipped: trigger command exited 0, the job runs on failure only"
		}
		return true, ""
	default: // success, including stored rows from before the field existed
		if !succeeded {
			var msg string // empty when the command failed without an error
			if err != nil {
				msg = err.Error()
			}
			detail := orNone(strings.TrimSpace(clipRunes(msg, maxGateNote)))
			return false, fmt.Sprintf("skipped: trigger command exited %d (%s)", code, detail)
		}
		return true, ""
	}
}

// prependGateOutput folds the gate's output ahead of the prompt, so the
// session sees what its pre-run command printed before it starts.
func prependGateOutput(command string, code int, out, prompt string) string {
	outcome := "succeeded"
	if code != 0 {
		outcome = fmt.Sprintf("failed with exit %d", code)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Pre-run command `%s` %s; its output:\n\n", command, outcome)
	b.WriteString(clipRunes(strings.TrimRight(out, "\n"), triggerOutputMax))
	b.WriteString("\n\n---\n\n")
	b.WriteString(prompt)
	return b.String()
}

// clipRunes bounds s to at most n runes.
func clipRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// pendingID is the synthetic correlation every fire derives from its run id,
// so queue rows and committed entries resolve deterministically.
func pendingID(run store.Run) string {
	return fmt.Sprintf("run-%d", run.ID)
}
