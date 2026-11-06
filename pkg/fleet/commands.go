package fleet

import (
	"context"

	"github.com/jentfoo/ajent/pkg/client"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// Session commands proxy one browser call onto the session's control socket.
// Every verb runs on the session actor goroutine through its mailbox, so one
// command is in flight per session and never inside the event pump; wire
// refusals surface as *ctl.Error for the API layer to map onto statuses.

type msgSubmit struct {
	params ctl.SubmitParams
	reply  chan error
}

type msgInterrupt struct{ reply chan cmdStopped }

// cmdStopped names what an interrupt stopped.
type cmdStopped struct {
	stopped string
	err     error
}

type msgModeCycle struct {
	back  bool
	mode  string // non-empty sets by name instead of stepping
	reply chan cmdString
}

type msgRewind struct {
	head  string
	reply chan cmdString
}

// cmdString carries one string result beside its error.
type cmdString struct {
	value string
	err   error
}

type msgResolve struct {
	params ctl.ResolveParams
	reply  chan error
}

type msgRecall struct{ reply chan cmdRecall }

// cmdRecall carries the popped queue row beside its error.
type cmdRecall struct {
	row ctl.RecallResult
	err error
}

type msgSnapshot struct{ reply chan snapshotReply }

// StampedState pairs one reconciled snapshot with the actor watermark it was
// read under: every event at or below Seq had applied when these fields were
// taken, so a client compares stamps to judge which side is fresher.
type StampedState struct {
	ctl.State
	Seq uint64 `json:"seq"`
}

// Snapshot command messages for the upstream control methods.
type msgSnapshotModels struct{ reply chan cmdModels }

type msgSnapshotModelSet struct {
	model string
	reply chan cmdString
}

type msgSnapshotTools struct {
	names []string
	reply chan cmdTools
}

type msgSnapshotSettings struct {
	reply chan cmdSettings[ctl.SettingsData]
}

type msgSnapshotSettingSet struct {
	params ctl.SettingsSetParams
	reply  chan cmdSettings[ctl.SettingsSetResult]
}

// snapshotReply carries one stamped state beside why it is missing.
type snapshotReply struct {
	state StampedState
	err   error
}

// cmdModels carries a models.get listing beside its error.
type cmdModels struct {
	data ctl.ModelsData
	err  error
}

// cmdTools carries the tool rows after a reshape beside its error.
type cmdTools struct {
	res ctl.ToolsSetResult
	err error
}

// cmdSettings carries a settings.get listing or one applied row beside its error.
type cmdSettings[T any] struct {
	data T
	err  error
}

// ready reports whether upstream commands can run: a live connection with a
// seeded view.
func (a *sessionActor) ready() bool { return a.conn != nil && a.view != nil }

// ensureWriteSeat lazily claims the seat before a write when this connection
// does not hold it, per the external-session policy: a human --attach is never
// displaced without asking, so a held seat surfaces as its coded refusal.
func (a *sessionActor) ensureWriteSeat() error {
	if a.view.seat.Yours {
		return nil
	}
	cctx, cancel := a.callWait()
	defer cancel()
	if _, err := a.conn.ClaimSeat(cctx, holderName, false); err != nil {
		return err
	}
	a.view.seat = ctl.SeatState{Held: true, Holder: holderName, Yours: true}
	a.refreshStatus()
	return nil
}

// notReady is the refusal every command answers while the connection is down.
func notReady() error { return ctl.Errf(ctl.CodeUnavailable, "session is not connected") }

// callWait binds one upstream control call to the standard request budget,
// anchored on the actor's context so a stopping actor fails fast.
func (a *sessionActor) callWait() (context.Context, context.CancelFunc) {
	return context.WithTimeout(a.ctx, client.CallWait)
}

// handleSubmit routes one prompt line exactly as typed in the session editor.
func (a *sessionActor) handleSubmit(msg msgSubmit) {
	if !a.ready() {
		msg.reply <- notReady()
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- err
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	msg.reply <- a.conn.Submit(cctx, msg.params)
}

// handleInterrupt runs the Esc body remotely.
func (a *sessionActor) handleInterrupt(msg msgInterrupt) {
	if !a.ready() {
		msg.reply <- cmdStopped{err: notReady()}
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- cmdStopped{err: err}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	stopped, err := a.conn.Interrupt(cctx)
	msg.reply <- cmdStopped{stopped: stopped, err: err}
}

// handleModeCycle steps the permission mode like Shift+Tab, or jumps straight
// to a named mode when one rides along.
func (a *sessionActor) handleModeCycle(msg msgModeCycle) {
	if !a.ready() {
		msg.reply <- cmdString{err: notReady()}
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- cmdString{err: err}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	var mode string
	var err error
	if msg.mode != "" { // the dropdown's direct set; cycling stays for chips
		mode, err = a.conn.ModeSet(cctx, msg.mode)
	} else {
		mode, err = a.conn.ModeCycle(cctx, msg.back)
	}
	msg.reply <- cmdString{value: mode, err: err}
}

// handleRewind forks onto an earlier transcript entry; candidate rules stay
// upstream's, so a refused head keeps its coded refusal.
func (a *sessionActor) handleRewind(msg msgRewind) {
	if !a.ready() {
		msg.reply <- cmdString{err: notReady()}
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- cmdString{err: err}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	head, err := a.conn.Rewind(cctx, msg.head)
	msg.reply <- cmdString{value: head, err: err}
}

// handleResolve answers one open dialog; resolution runs off the lane
// upstream, so its reply follows the first answer that won.
func (a *sessionActor) handleResolve(msg msgResolve) {
	if !a.ready() {
		msg.reply <- notReady()
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- err
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	msg.reply <- a.conn.Resolve(cctx, msg.params)
}

// handleRecall pops the newest queued prompt for edit-and-resubmit.
func (a *sessionActor) handleRecall(msg msgRecall) {
	if !a.ready() {
		msg.reply <- cmdRecall{err: notReady()}
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- cmdRecall{err: err}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	row, err := a.conn.QueueRecall(cctx)
	msg.reply <- cmdRecall{row: row, err: err}
}

// handleSnapshot reads the actor's reconciled state for polling clients. The
// stamp shares the read with event application on this goroutine, so every
// event at or below it is already folded into the fields.
func (a *sessionActor) handleSnapshot(msg msgSnapshot) {
	if !a.ready() {
		msg.reply <- snapshotReply{err: notReady()}
		return
	}
	msg.reply <- snapshotReply{state: StampedState{State: a.view.snapshot(), Seq: a.view.seq}}
}

// --- upstream control-method commands ---

// handleModels lists the session's model registry; answers any seat.
func (a *sessionActor) handleModels(msg msgSnapshotModels) {
	if !a.ready() {
		msg.reply <- cmdModels{err: notReady()}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	data, err := a.conn.Models(cctx)
	msg.reply <- cmdModels{data: data, err: err}
}

// handleModelSet switches the session-only model; refuses while unheld.
func (a *sessionActor) handleModelSet(msg msgSnapshotModelSet) {
	if !a.ready() {
		msg.reply <- cmdString{err: notReady()}
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- cmdString{err: err}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	res, err := a.conn.ModelSet(cctx, msg.model)
	msg.reply <- cmdString{value: res.Model.Key, err: err}
}

// handleToolsSet reshapes the enabled tool set through tools.set.
func (a *sessionActor) handleToolsSet(msg msgSnapshotTools) {
	if !a.ready() {
		msg.reply <- cmdTools{err: notReady()}
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- cmdTools{err: err}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	res, err := a.conn.ToolsSet(cctx, msg.names)
	msg.reply <- cmdTools{res: res, err: err}
}

// handleSettings lists the /settings rows; answers any seat.
func (a *sessionActor) handleSettings(msg msgSnapshotSettings) {
	if !a.ready() {
		msg.reply <- cmdSettings[ctl.SettingsData]{err: notReady()}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	data, err := a.conn.Settings(cctx)
	msg.reply <- cmdSettings[ctl.SettingsData]{data: data, err: err}
}

// handleSettingSet applies one setting through settings.set.
func (a *sessionActor) handleSettingSet(msg msgSnapshotSettingSet) {
	if !a.ready() {
		msg.reply <- cmdSettings[ctl.SettingsSetResult]{err: notReady()}
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- cmdSettings[ctl.SettingsSetResult]{err: err}
		return
	}
	cctx, cancel := a.callWait()
	defer cancel()
	res, err := a.conn.SettingsSet(cctx, msg.params)
	msg.reply <- cmdSettings[ctl.SettingsSetResult]{data: res, err: err}
}

// mailboxCommand routes one command through the actor's mailbox under the
// standard request budget, so a busy or wedged actor answers as a timeout.
func mailboxCommand[T any](ctx context.Context, a *sessionActor, build func(chan T) actorMsg) (T, error) {
	cctx, cancel := context.WithTimeout(ctx, client.CallWait)
	defer cancel()
	return mailboxCall(cctx, a, build)
}

// Submit routes one prompt line through the session's control socket. The
// pendingId, when empty, is minted by the caller so optimistic rows resolve.
func (m *Manager) Submit(ctx context.Context, sessionID string, params ctl.SubmitParams) error {
	a := m.route(sessionID)
	if a == nil {
		return ErrUnknownSession
	}
	err, _ := mailboxCommand(ctx, a, func(reply chan error) actorMsg {
		return msgSubmit{params: params, reply: reply}
	})
	return err
}

// Interrupt runs the session's Esc body and names what stopped: turn, survey,
// shell or empty when nothing ran.
func (m *Manager) Interrupt(ctx context.Context, sessionID string) (string, error) {
	a := m.route(sessionID)
	if a == nil {
		return "", ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdStopped) actorMsg {
		return msgInterrupt{reply: reply}
	})
	if err != nil {
		return "", err
	}
	return res.stopped, res.err
}

// ModeCycle steps the permission mode, backwards when back. The returned name
// is the mode now in effect, empty when no gate exists.
func (m *Manager) ModeCycle(ctx context.Context, sessionID string, back bool) (string, error) {
	return m.modeChange(ctx, sessionID, msgModeCycle{back: back})
}

// ModeSet jumps the permission mode straight to a named level. The returned
// name is the mode now in effect; refusals carry upstream's message.
func (m *Manager) ModeSet(ctx context.Context, sessionID string, mode string) (string, error) {
	return m.modeChange(ctx, sessionID, msgModeCycle{mode: mode})
}

// modeChange routes one mode mutation onto the session actor.
func (m *Manager) modeChange(ctx context.Context, sessionID string, msg msgModeCycle) (string, error) {
	a := m.route(sessionID)
	if a == nil {
		return "", ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdString) actorMsg {
		msg.reply = reply
		return msg
	})
	if err != nil {
		return "", err
	}
	return res.value, res.err
}

// Rewind forks onto an earlier transcript entry and reports the new head.
func (m *Manager) Rewind(ctx context.Context, sessionID, head string) (string, error) {
	a := m.route(sessionID)
	if a == nil {
		return "", ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdString) actorMsg {
		return msgRewind{head: head, reply: reply}
	})
	if err != nil {
		return "", err
	}
	return res.value, res.err
}

// Resolve answers one pending interaction by id. A dialog that already
// resolved refuses with the settled code; the first answer won.
func (m *Manager) Resolve(ctx context.Context, sessionID string, params ctl.ResolveParams) error {
	a := m.route(sessionID)
	if a == nil {
		return ErrUnknownSession
	}
	err, _ := mailboxCommand(ctx, a, func(reply chan error) actorMsg {
		return msgResolve{params: params, reply: reply}
	})
	return err
}

// Recall pops the newest queued prompt by its row id so a composer can offer
// edit-and-resubmit. A zero result means nothing was queued.
func (m *Manager) Recall(ctx context.Context, sessionID string) (ctl.RecallResult, error) {
	a := m.route(sessionID)
	if a == nil {
		return ctl.RecallResult{}, ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdRecall) actorMsg {
		return msgRecall{reply: reply}
	})
	if err != nil {
		return ctl.RecallResult{}, err
	}
	return res.row, res.err
}

// Snapshot serves one session's reconciled state for polling clients, the
// same shape a stream init carries beside the watermark it was read under.
func (m *Manager) Snapshot(ctx context.Context, sessionID string) (StampedState, error) {
	a := m.route(sessionID)
	if a == nil {
		return StampedState{}, ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan snapshotReply) actorMsg {
		return msgSnapshot{reply: reply}
	})
	if err != nil {
		return StampedState{}, err
	}
	return res.state, res.err
}

// Models lists the session's model registry exactly as the running process
// resolved it, with the key now in effect.
func (m *Manager) Models(ctx context.Context, sessionID string) (ctl.ModelsData, error) {
	a := m.route(sessionID)
	if a == nil {
		return ctl.ModelsData{}, ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdModels) actorMsg {
		return msgSnapshotModels{reply: reply}
	})
	if err != nil {
		return ctl.ModelsData{}, err
	}
	return res.data, res.err
}

// ModelSet switches the session onto one model, session-only: no config layer
// is rewritten. The reply names the canonical key it resolved to.
func (m *Manager) ModelSet(ctx context.Context, sessionID, model string) (string, error) {
	a := m.route(sessionID)
	if a == nil {
		return "", ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdString) actorMsg {
		return msgSnapshotModelSet{model: model, reply: reply}
	})
	if err != nil {
		return "", err
	}
	return res.value, res.err
}

// ToolsSet reshapes the enabled tool set through ajent's own apply and answers
// the full-replacement rows after it.
func (m *Manager) ToolsSet(ctx context.Context, sessionID string, names []string) (ctl.ToolsSetResult, error) {
	a := m.route(sessionID)
	if a == nil {
		return ctl.ToolsSetResult{}, ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdTools) actorMsg {
		return msgSnapshotTools{names: names, reply: reply}
	})
	if err != nil {
		return ctl.ToolsSetResult{}, err
	}
	return res.res, res.err
}

// Settings lists the /settings rows with values, sources and editability.
func (m *Manager) Settings(ctx context.Context, sessionID string) (ctl.SettingsData, error) {
	a := m.route(sessionID)
	if a == nil {
		return ctl.SettingsData{}, ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdSettings[ctl.SettingsData]) actorMsg {
		return msgSnapshotSettings{reply: reply}
	})
	if err != nil {
		return ctl.SettingsData{}, err
	}
	return res.data, res.err
}

// SettingSet applies one setting as a session override with its live effects,
// optionally persisting to a config layer. The reply is the row after.
func (m *Manager) SettingSet(ctx context.Context, sessionID string, params ctl.SettingsSetParams) (ctl.SettingsSetResult, error) {
	a := m.route(sessionID)
	if a == nil {
		return ctl.SettingsSetResult{}, ErrUnknownSession
	}
	res, err := mailboxCommand(ctx, a, func(reply chan cmdSettings[ctl.SettingsSetResult]) actorMsg {
		return msgSnapshotSettingSet{params: params, reply: reply}
	})
	if err != nil {
		return ctl.SettingsSetResult{}, err
	}
	return res.data, res.err
}
