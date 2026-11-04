package fleet

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jentfoo/ajent/pkg/client"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// holderName is the seat name swarm claims on sessions it spawned, so a
// refusal naming it always means this service.
const holderName = "swarm"

// errShuttingDown answers calls racing an actor's teardown.
var errShuttingDown = errors.New("session is shutting down")

// Backoff bounds for one actor's redial loop. Bounded delay, unbounded
// attempts: the manager stops actors whose record leaves discovery.
const (
	dialBackoffBase = 500 * time.Millisecond
	dialBackoffMax  = 8 * time.Second

	// backfillWait covers state.get plus a full transcript read; big files
	// need more than one call budget.
	backfillWait = 30 * time.Second

	mailboxDepth = 1024
)

// protocolMismatchText matches client.Dial's version refusal, which carries no
// sentinel error. A mismatch is a per-session error for viewers to render,
// never a global failure.
const protocolMismatchText = "speaks control protocol"

type actorKey struct {
	sessionID string
	token     string
}

// Status is one row of the fleet listing: what the manager knows about an
// instance's session without subscribing to its stream.
type Status struct {
	SessionID        string `json:"sessionId"`
	Name             string `json:"name,omitempty"`
	Title            string `json:"title,omitempty"` // stored display title, preferred for labels
	Workspace        string `json:"workspace,omitempty"`
	Model            string `json:"model,omitempty"`
	PID              int    `json:"pid,omitempty"`
	State            string `json:"state"` // one of the Child* constants
	Detail           string `json:"detail,omitempty"`
	SeatHeld         bool   `json:"seatHeld"`
	SeatHolder       string `json:"seatHolder,omitempty"`
	SeatOurs         bool   `json:"seatOurs"`
	Running          bool   `json:"running"`
	Idle             bool   `json:"idle"`
	Spinning         bool   `json:"spinning,omitempty"`
	OpenInteractions int    `json:"openInteractions"`
	LastTurnEnd      int64  `json:"lastTurnEnd,omitempty"` // unix milliseconds
	ExitedAt         int64  `json:"exitedAt,omitempty"`    // unix ms; ended sessions

	// Attention digest facts: what holds input and how the last turn ended,
	// one line each so the desktop focus queue renders reasons without subscribing.
	DialogID     uint64 `json:"dialogId,omitempty"`     // oldest open dialog
	DialogPrompt string `json:"dialogPrompt,omitempty"` // its prompt, one line
	DialogAt     int64  `json:"dialogAt,omitempty"`     // when swarm first saw it, unix ms
	LastStop     string `json:"lastStop,omitempty"`     // stop reason of the last turn
	LastStopErr  string `json:"lastStopErr,omitempty"`  // transport or context failure
	Activity     string `json:"activity,omitempty"`     // top activity row, one line

	// Spawn facts for children swarm launched: empty fields mean external or
	// unknown. ExitCode appears once reaped, negative when a signal ended it;
	// LogTail carries ajent's own failure hints for a reopen affordance.
	SpawnedBy string `json:"spawnedBy"`
	Argv      string `json:"argv,omitempty"`
	LogPath   string `json:"logPath,omitempty"`
	ExitCode  *int   `json:"exitCode,omitempty"`
	LogTail   string `json:"logTail,omitempty"`

	served bool // the actor attached at least once, so view facts are real
}

// serving reports whether the row carries live view facts: the actor
// attached at least once and the session has not exited. Every best-effort
// feed filters on it.
func (st *Status) serving() bool { return st.served && st.State != ChildExited }

// actorMsg is one mailbox message; the actor goroutine owns everything else.
type actorMsg interface{}

type msgUpstream struct {
	gen uint64
	ev  ctl.Event
}

type msgAttach struct{ sub *subscription }

type msgDetach struct{ sub *subscription }

type msgSync struct{ sub *subscription }

type msgTakeControl struct{ reply chan error }

type msgStop struct{ reply chan error }

type msgEntries struct {
	before string
	limit  int
	reply  chan entriesPage
}

// rewindSource carries what a transcript-tree read needs beside the live head.
type rewindSource struct {
	head string // current branch tip from the reconciled view
	path string // transcript file the hello named
	ok   bool   // a view exists to take the head from
}

// entriesPage answers one paging request.
type entriesPage struct {
	entries []ctl.Entry
	cursor  string
}

// sessionActor is the per-instance goroutine: dial, seat policy, backfill,
// watermark machine and fanout, all sequenced through its mailbox. The view
// and connection state never touch a lock.
type sessionActor struct {
	mgr    *Manager
	key    actorKey
	inst   ctl.Instance // discovery record at spawn; hello refreshes the pid
	log    *slog.Logger
	ctx    context.Context
	cancel context.CancelFunc

	mailbox chan actorMsg
	hub     *hub
	status  atomicStatus

	done chan struct{}

	// actor-goroutine-confined state below
	conn       *client.Conn
	transcript string // transcript file this instance's hello named
	gen        uint64 // connection generation; stale messages drop by it
	view       *view
	pending    map[*subscription]struct{} // subscribers waiting for the first backfill
	state      string
	detail     string
	backoff    time.Duration
}

// atomicStatus keeps the listing row readable off the actor goroutine.
type atomicStatus struct {
	p atomic.Pointer[Status]
}

func (s *atomicStatus) Store(st *Status) { s.p.Store(st) }

func (s *atomicStatus) Load() *Status {
	if st := s.p.Load(); st != nil {
		return st
	}
	return &Status{} // never connected
}

func newSessionActor(mgr *Manager, inst ctl.Instance) *sessionActor {
	a := &sessionActor{
		mgr:     mgr,
		key:     actorKey{sessionID: inst.SessionID, token: inst.Token},
		inst:    inst,
		log:     mgr.log.With("session", inst.Label(), "pid", inst.PID),
		mailbox: make(chan actorMsg, mailboxDepth),
		hub:     newHub(),
		pending: make(map[*subscription]struct{}),
		done:    make(chan struct{}),
		state:   ChildReconnecting,
		backoff: mgr.dialBackoffBase,
	}
	a.ctx, a.cancel = context.WithCancel(mgr.ctx)
	a.refreshStatus()
	return a
}

// run drives one instance until the manager stops it or its session exits.
func (a *sessionActor) run() {
	defer close(a.done)
	for a.ctx.Err() == nil {
		if !a.connectAttempt() {
			return
		}
		a.flushPending() // adopted-and-waiting viewers attach before online is announced
		a.publishChild(ChildOnline, "")
		lost := a.serveLoop()
		if a.state == ChildExited || a.ctx.Err() != nil {
			a.idleUntilStopped()
			return
		}
		a.publishChild(ChildReconnecting, lost)
		if !a.waitBackoff() {
			return
		}
	}
}

// connectAttempt dials and prepares the followed instance, retrying under
// bounded backoff until a connection is live or the actor stops. True means
// a prepared connection is in place and the serve loop may run.
func (a *sessionActor) connectAttempt() bool {
	for {
		if a.tryConnect() {
			return true
		}
		if a.ctx.Err() != nil || !a.waitBackoff() {
			return false
		}
	}
}

// tryConnect makes one dial-and-prepare pass, reporting success. A failure
// lands in the degraded listing state with its detail.
func (a *sessionActor) tryConnect() bool {
	target := a.inst
	if a.gen > 0 { // past the first attempt, follow discovery's rule
		inst, ok := a.follow()
		if !ok {
			a.publishChild(ChildReconnecting, "waiting for the session to come back")
			return false
		}
		target = inst
	}

	conn, hello, err := client.Dial(target.Socket)
	if err != nil {
		detail := err.Error()
		if strings.Contains(detail, protocolMismatchText) {
			a.log.Warn("control protocol mismatch", "err", detail)
		} else {
			a.log.Debug("dial failed", "err", detail)
		}
		a.publishChild(ChildReconnecting, detail)
		return false
	}

	a.inst = target
	a.gen++
	gen := a.gen
	go conn.Serve(func(ev ctl.Event) { // started before any call, per the client contract
		select {
		case a.mailbox <- msgUpstream{gen: gen, ev: ev}:
		default:
			conn.Close() // wedged actor: fail open, reconnect resyncs
		}
	})
	a.conn = conn

	if err := a.prepare(conn, hello); err != nil {
		conn.Close()
		a.publishChild(ChildReconnecting, err.Error())
		return false
	}
	a.backoff = a.mgr.dialBackoffBase
	return true
}

// follow re-resolves the instance to dial through Followable's rule: the same
// token while it serves, else a sole surviving instance of the session.
func (a *sessionActor) follow() (ctl.Instance, bool) {
	live, err := a.mgr.discover()
	if err != nil {
		a.log.Debug("discovery failed", "err", err)
		return ctl.Instance{}, false
	}
	cands := client.Followable(live, a.key.sessionID, a.key.token)
	if len(cands) == 0 {
		return ctl.Instance{}, false
	}
	return cands[0], true
}

// prepare claims the seat per policy and seeds the view from backfill.
func (a *sessionActor) prepare(conn *client.Conn, hello ctl.Hello) error {
	a.inst.PID = hello.PID
	a.transcript = hello.TranscriptPath
	if a.mgr.ownedInstance(a.inst) { // spawned by swarm: force-claim as holder swarm
		cctx, cancel := context.WithTimeout(a.ctx, client.CallWait)
		defer cancel()
		if _, err := conn.ClaimSeat(cctx, holderName, true); err != nil {
			return fmt.Errorf("force claim seat: %w", err)
		}
	}

	bctx, bcancel := context.WithTimeout(a.ctx, backfillWait)
	defer bcancel()
	snap, branch, watermark, err := conn.Backfill(bctx)
	if err != nil {
		// recording is always on in serve mode, so a missing transcript is an
		// error to report and retry, never a mode to render around
		return fmt.Errorf("backfill: %w", err)
	}

	a.view = buildView(snap, branch, watermark)
	if a.mgr.ownedInstance(a.inst) {
		a.view.seat = ctl.SeatState{Held: true, Holder: holderName, Yours: true}
	}
	// adopted sessions name from backfill too: their first prompt predates the
	// live stream, so no entry.append announces it; guards keep reconnects cheap
	a.mgr.maybeNameSession(a)
	return nil
}

// serveLoop applies events and serves subscribers while the connection lives,
// returning what it knows about why the connection ended.
func (a *sessionActor) serveLoop() string {
	done := a.conn.Done()
	for {
		select {
		case <-done:
			a.drainUpstream() // events decoded before the close still apply
			if a.state == ChildExited {
				return ""
			}
			err := a.conn.Err()
			a.closeConn()
			if err == nil {
				return "connection lost"
			}
			return err.Error()
		case <-a.ctx.Done():
			a.closeConn()
			return ""
		case m := <-a.mailbox:
			a.handle(m)
			if a.state == ChildExited && a.conn == nil {
				return "" // session.exit closed the connection under us
			}
		}
	}
}

// drainUpstream applies every event already delivered for the live generation.
// Serve stops before Done closes, so this pass is deterministic: a queued
// session.exit marks the clean end no matter which select arm won the race.
func (a *sessionActor) drainUpstream() {
	for {
		select {
		case m := <-a.mailbox:
			if up, ok := m.(msgUpstream); ok {
				if up.gen == a.gen && a.state != ChildExited {
					a.applyEvent(up.ev)
				}
				continue
			}
			a.handle(m)
		default:
			return
		}
	}
}

// idleUntilStopped keeps serving subscribers with the final view after a clean
// exit; tracking ends when the manager sees the record leave discovery.
func (a *sessionActor) idleUntilStopped() {
	for {
		select {
		case <-a.ctx.Done():
			return
		case m := <-a.mailbox:
			a.handle(m)
		}
	}
}

// handle runs one mailbox message on the actor goroutine.
func (a *sessionActor) handle(m actorMsg) {
	switch msg := m.(type) {
	case msgUpstream:
		if msg.gen == a.gen {
			a.applyEvent(msg.ev)
		}
	case msgAttach:
		a.attachSub(msg.sub)
	case msgDetach:
		a.hub.detach(msg.sub)
		delete(a.pending, msg.sub)
	case msgSync:
		if a.hub.has(msg.sub.id) {
			msg.sub.publishFrame(a.buildInit())
		} else {
			msg.sub.publishFrame(mustJSON(ErrorFrame{
				Type: FrameError, SessionID: msg.sub.sessionID, Code: "not_subscribed",
			}))
		}
	case msgTakeControl:
		a.handleTakeControl(msg)
	case msgStop:
		a.handleStop(msg)
	case msgEntries:
		page := entriesPage{entries: []ctl.Entry{}}
		if a.view != nil {
			page.entries, page.cursor = a.view.pageEntries(msg.before, msg.limit)
		}
		msg.reply <- page
	case msgSubmit:
		a.handleSubmit(msg)
	case msgInterrupt:
		a.handleInterrupt(msg)
	case msgModeCycle:
		a.handleModeCycle(msg)
	case msgRewind:
		a.handleRewind(msg)
	case msgResolve:
		a.handleResolve(msg)
	case msgRecall:
		a.handleRecall(msg)
	case msgSnapshot:
		a.handleSnapshot(msg)
	case msgSnapshotModels:
		a.handleModels(msg)
	case msgSnapshotModelSet:
		a.handleModelSet(msg)
	case msgSnapshotTools:
		a.handleToolsSet(msg)
	case msgSnapshotSettings:
		a.handleSettings(msg)
	case msgSnapshotSettingSet:
		a.handleSettingSet(msg)
	case msgRewindSource:
		src := rewindSource{path: a.transcript, ok: a.view != nil}
		if a.view != nil {
			src.head = a.view.head
		}
		msg.reply <- src
	}
}

// applyEvent reconciles one upstream event into the view and fans it out.
func (a *sessionActor) applyEvent(ev ctl.Event) {
	exited := ev.Name == ctl.EventSessionExit // always last before close
	if a.view != nil {
		a.view.apply(ev)
	}
	a.hub.publishEvent(a.key.sessionID, ev)
	if exited {
		var d ctl.SessionExitData
		_ = ev.Decode(&d)
		a.exit(d.Reason)
		return
	}
	a.refreshStatus()
	if ev.Name == ctl.EventEntryAppend { // the first prompt may name the session
		a.mgr.maybeNameSession(a)
	}
}

// attachSub registers one subscriber with the current state: init first, then
// the lifecycle frame telling it which epoch it joined. Before the first
// backfill completes there is nothing to serve, so the subscriber waits in
// pending and flushes once the view exists.
func (a *sessionActor) attachSub(sub *subscription) {
	if a.view == nil {
		a.pending[sub] = struct{}{}
		return
	}
	var child *ChildFrame
	if a.state != ChildOnline {
		child = &ChildFrame{
			Type: FrameChild, SessionID: a.key.sessionID, State: a.state, Detail: a.detail,
		}
	}
	if sub.greet(a.buildInit(), child) { // retired mid-attach: the replacement owns it now
		sub.fireDrop()
		return
	}
	a.hub.attach(sub)
}

// flushPending serves everyone who subscribed before the first backfill.
func (a *sessionActor) flushPending() {
	for sub := range a.pending {
		if sub.greet(a.buildInit(), nil) { // retired while waiting: the replacement owns it
			sub.fireDrop()
			continue
		}
		a.hub.attach(sub)
	}
	a.pending = make(map[*subscription]struct{})
}

// buildInit encodes the subscribe answer from the reconciled view.
func (a *sessionActor) buildInit() []byte {
	entries, cursor := a.view.initTail()
	return mustJSON(InitFrame{
		Type:      FrameInit,
		SessionID: a.key.sessionID,
		State:     a.view.snapshot(),
		Entries:   entries,
		Cursor:    cursor,
	})
}

// handleTakeControl issues one force claim on user command; seat policy never
// force-takes on its own, so two controllers cannot steal in a loop.
func (a *sessionActor) handleTakeControl(msg msgTakeControl) {
	if !a.ready() {
		msg.reply <- notReady()
		return
	}
	cctx, cancel := context.WithTimeout(a.ctx, client.CallWait)
	defer cancel()
	if _, err := a.conn.ClaimSeat(cctx, holderName, true); err != nil {
		msg.reply <- err // seat-held keeps its holder name for the UI
		return
	}
	a.view.seat = ctl.SeatState{Held: true, Holder: holderName, Yours: true}
	a.refreshStatus()
	msg.reply <- nil
}

// handleStop ends the session through its own front door: claim the seat
// only when swarm does not hold it, then submit /exit. A held seat surfaces
// as seat-held rather than displacing its holder.
func (a *sessionActor) handleStop(msg msgStop) {
	if !a.ready() {
		msg.reply <- errors.New("session is not connected")
		return
	}
	if err := a.ensureWriteSeat(); err != nil {
		msg.reply <- err // seat-held names its holder
		return
	}
	cctx, cancel := context.WithTimeout(a.ctx, client.CallWait)
	defer cancel()
	msg.reply <- a.conn.Submit(cctx, ctl.SubmitParams{Line: stopLine})
}

// exit marks the clean end of a session run.
func (a *sessionActor) exit(reason string) {
	if a.state == ChildExited {
		return
	}
	a.closeConn()
	a.state = ChildExited
	a.detail = reason
	a.hub.publishChild(ChildFrame{
		Type: FrameChild, SessionID: a.key.sessionID, State: ChildExited, Detail: reason,
	})
	a.refreshStatus()
	a.log.Info("session exited", "reason", reason)
}

// publishChild records and fans out one lifecycle transition. Repeats of the
// same degraded state stay quiet; the listing's detail covers progress.
func (a *sessionActor) publishChild(state, detail string) {
	if state != ChildOnline && a.state == state && a.detail == detail {
		return
	}
	a.state = state
	a.detail = detail
	a.hub.publishChild(ChildFrame{
		Type: FrameChild, SessionID: a.key.sessionID, State: state, Detail: detail,
	})
	a.refreshStatus()
}

// waitBackoff sleeps one backoff step; false means stop.
func (a *sessionActor) waitBackoff() bool {
	timer := time.NewTimer(a.backoff)
	defer timer.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return false
		case <-timer.C:
			a.backoff = min(a.backoff*2, a.mgr.dialBackoffMax)
			return true
		case m := <-a.mailbox:
			a.handle(m)
		}
	}
}

func (a *sessionActor) closeConn() {
	if a.conn != nil {
		a.conn.Close() // releases any held seat upstream
		a.conn = nil
	}
}

// refreshStatus republishes the listing row from current state.
func (a *sessionActor) refreshStatus() {
	st := &Status{
		SessionID: a.key.sessionID,
		State:     a.state,
		Detail:    a.detail,
		PID:       a.inst.PID,
	}
	if a.view != nil {
		st.served = true // the listing and attention feeds only trust a seeded view
		st.Name = a.view.session.Name
		st.Workspace = a.view.workspace
		st.Model = a.view.model.Key
		st.SeatHeld = a.view.seat.Held
		st.SeatHolder = a.view.seat.Holder
		st.SeatOurs = a.view.seat.Yours
		st.Running = a.view.running
		st.Idle = a.view.idle
		st.Spinning = a.view.spinning
		st.OpenInteractions = len(a.view.interactions)
		st.LastTurnEnd = a.view.lastTurnEnd
		if dlg, at := a.view.oldestDialog(); dlg.ID != 0 {
			st.DialogID = dlg.ID
			st.DialogPrompt = digestText(dlg.Prompt)
			st.DialogAt = at
		}
		st.LastStop = a.view.lastStop
		st.LastStopErr = digestText(a.view.lastStopErr)
		st.Activity = digestText(a.view.activityPreview())
	}
	if st.Name == "" {
		st.Name = a.inst.SessionName
	}
	if st.Workspace == "" {
		st.Workspace = a.inst.Workspace
	}
	a.status.Store(st)
}

// stop shuts the actor down; safe to call again.
func (a *sessionActor) stop() {
	a.cancel() // context.CancelFunc is idempotent
}

// mailboxCall sends one request to the actor and awaits its reply, bounded
// by ctx. build constructs the message around a fresh reply channel.
func mailboxCall[T any](ctx context.Context, a *sessionActor, build func(chan T) actorMsg) (T, error) {
	reply := make(chan T, 1)
	select {
	case a.mailbox <- build(reply):
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	case <-a.done:
		var zero T
		return zero, errShuttingDown
	}
	select {
	case v := <-reply:
		return v, nil
	default:
	}
	select {
	case v := <-reply:
		return v, nil
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	case <-a.done: // an exit path can orphan the queued call unreplied
		select { // a reply sent just before shutdown still counts
		case v := <-reply:
			return v, nil
		default:
		}
		var zero T
		return zero, errShuttingDown
	}
}

// takeControl routes one force-claim request through the mailbox.
func (a *sessionActor) takeControl(ctx context.Context) error {
	err, _ := mailboxCall(ctx, a, func(reply chan error) actorMsg { return msgTakeControl{reply: reply} })
	return err
}

// stopExit routes one stop request through the mailbox.
func (a *sessionActor) stopExit(ctx context.Context) error {
	err, _ := mailboxCall(ctx, a, func(reply chan error) actorMsg { return msgStop{reply: reply} })
	return err
}

// entries routes one paging request through the mailbox.
func (a *sessionActor) entries(ctx context.Context, before string, limit int) ([]ctl.Entry, string) {
	page, err := mailboxCall(ctx, a, func(reply chan entriesPage) actorMsg {
		return msgEntries{before: before, limit: limit, reply: reply}
	})
	if err != nil {
		return nil, ""
	}
	return page.entries, page.cursor
}
