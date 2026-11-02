// Package fleet watches ajent's control registry and keeps one faithful,
// reconciled view per live instance: an actor goroutine per (session, token)
// holds the upstream connection, runs the watermark machine over its event
// stream and fans results out to any number of WebSocket viewers.
package fleet

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/client"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// Poll defaults for the registry watch. Discovery reads records only, never
// watches socket files and never dials.
const (
	pollEvery     = time.Second
	pollErrorMax  = 30 * time.Second
	stopActorWait = 5 * time.Second
)

// ErrUnknownSession reports a subscribe or command naming no tracked instance.
var ErrUnknownSession = errors.New("unknown session")

// Options tunes the manager; zero values take production defaults.
type Options struct {
	Log          *slog.Logger
	PollInterval time.Duration // registry watch cadence, about once a second
	BackoffBase  time.Duration // actor redial base
	BackoffMax   time.Duration // actor redial cap

	// Owned names sessions swarm spawned; they force-claim the seat as holder
	// swarm at attach. External sessions observe until a write or an explicit
	// take-control, so a human --attach is never displaced without asking.
	Owned func(inst ctl.Instance) bool

	// Discover reads the live registry; client.DiscoverLive when unset.
	Discover func() ([]ctl.Instance, error)

	// Child launching: AjentBin and ChildrenDir must both be set for Launch
	// to work. ChildStore persistence enables orphan re-adoption across
	// restarts; KillOnExit opts into terminating running children at Stop.
	AjentBin    string
	ChildrenDir string
	ChildStore  ChildStore
	KillOnExit  bool
	LaunchWait  time.Duration // spawn-to-socket deadline
	ExitGrace   time.Duration // /exit settles before SIGTERM
	TermGrace   time.Duration // SIGTERM before SIGKILL
}

// Manager tracks every live ajent instance and owns its actors' lifecycles.
type Manager struct {
	log             *slog.Logger
	pollInterval    time.Duration
	dialBackoffBase time.Duration
	dialBackoffMax  time.Duration
	optsOwned       func(ctl.Instance) bool
	discover        func() ([]ctl.Instance, error)

	bin         string
	childrenDir string
	childStore  ChildStore
	killOnExit  bool
	launchWait  time.Duration
	exitGrace   time.Duration
	termGrace   time.Duration

	ctx      context.Context
	cancel   context.CancelFunc
	storeCtx context.Context // never canceled: child bookkeeping outlives every caller
	wg       sync.WaitGroup
	stopOnce sync.Once

	mu             sync.Mutex
	actors         map[actorKey]*sessionActor
	subs           map[int64]*subscription
	bySession      map[string]map[int64]*subscription
	nextSubID      int64 // manager-owned subscription identity
	nudge          chan struct{}
	children       map[int]*childProc // by pid, running and exited
	childBySession map[string]int
}

// New builds a manager; Start begins the registry watch.
func New(opts Options) *Manager {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	m := &Manager{
		log:             opts.Log,
		pollInterval:    cmpOr(opts.PollInterval, pollEvery),
		dialBackoffBase: cmpOr(opts.BackoffBase, dialBackoffBase),
		dialBackoffMax:  cmpOr(opts.BackoffMax, dialBackoffMax),
		optsOwned:       opts.Owned,
		bin:             opts.AjentBin,
		childrenDir:     opts.ChildrenDir,
		childStore:      opts.ChildStore,
		killOnExit:      opts.KillOnExit,
		launchWait:      cmpOr(opts.LaunchWait, launchWaitDefault),
		exitGrace:       cmpOr(opts.ExitGrace, exitGraceDefault),
		termGrace:       cmpOr(opts.TermGrace, termGraceDefault),
		actors:          make(map[actorKey]*sessionActor),
		subs:            make(map[int64]*subscription),
		bySession:       make(map[string]map[int64]*subscription),
		nudge:           make(chan struct{}, 1),
		children:        make(map[int]*childProc),
		childBySession:  make(map[string]int),
	}
	if m.optsOwned == nil {
		m.optsOwned = func(ctl.Instance) bool { return false }
	}
	if m.discover == nil {
		m.discover = client.DiscoverLive
	}
	return m
}

func cmpOr(v, fallback time.Duration) time.Duration {
	if v > 0 {
		return v
	}
	return fallback
}

// ownedInstance reports whether swarm spawned the instance's process,
// directly or via re-adoption, so the seat policy can force-claim it.
func (m *Manager) ownedInstance(inst ctl.Instance) bool {
	if m.optsOwned(inst) {
		return true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cp, ok := m.children[inst.PID]
	return ok && cp.rec.ExitedAt.IsZero()
}

// Start begins watching the registry until Stop.
func (m *Manager) Start(ctx context.Context) {
	m.ctx, m.cancel = context.WithCancel(ctx)
	m.storeCtx = context.WithoutCancel(ctx)
	m.adopt(ctx)
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.watch(m.ctx)
	}()
}

// Stop shuts every actor down and releases its subscribers. Children
// outlive it unless the operator asked for them to be taken down too.
func (m *Manager) Stop() {
	m.stopOnce.Do(func() {
		if m.cancel != nil {
			m.cancel()
		}
		m.wg.Wait()

		m.mu.Lock()
		subs := bulk.MapValuesSlice(m.subs)
		m.actors = make(map[actorKey]*sessionActor)
		m.subs = make(map[int64]*subscription)
		m.bySession = make(map[string]map[int64]*subscription)
		m.mu.Unlock()
		for _, sub := range subs {
			sub.close()
		}

		if m.killOnExit {
			m.killChildren()
		}
	})
}

// watch polls discovery and reconciles the actor set against it, backing off
// when discovery itself fails so a broken control directory never spins.
func (m *Manager) watch(ctx context.Context) {
	interval := m.pollInterval
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		case <-m.nudge: // a fresh child wants attaching without the wait
		}
		m.reconcileAdopted()
		if err := m.diff(); err != nil { //nolint:contextcheck // actors bind their context at spawn; requests cross the mailbox, not call chains
			m.log.Warn("discovery failed", "err", err)
			interval = min(interval*2, pollErrorMax)
			continue
		}
		interval = m.pollInterval
	}
}

// diff starts actors for new instances and stops those whose record left.
func (m *Manager) diff() error {
	live, err := m.discover()
	if err != nil {
		return err
	}

	m.mu.Lock()
	var stopping []*sessionActor
	var gone []*subscription // hosted by the instances this pass retires
	for key, a := range m.actors {
		if !slices.ContainsFunc(live, func(in ctl.Instance) bool {
			return in.SessionID == key.sessionID && in.Token == key.token
		}) {
			stopping = append(stopping, a)
			delete(m.actors, key)
		}
	}
	// their subscribers wait for a replacement instance to adopt them
	for _, a := range stopping {
		gone = append(gone, m.orphanLocked(a.key)...)
	}

	var starting []ctl.Instance
	for _, inst := range live {
		key := actorKey{sessionID: inst.SessionID, token: inst.Token}
		if _, tracked := m.actors[key]; tracked {
			continue
		}
		a := newSessionActor(m, inst)
		m.actors[key] = a
		starting = append(starting, inst)
	}
	rebinds := m.planRebinds()
	m.mu.Unlock()

	// retiring instances tell their subscribers directly: publishing from here
	// cannot race an attach still sitting in the actor's mailbox
	for _, sub := range gone {
		if sub.retire() {
			sub.fireDrop()
		}
	}

	for _, a := range stopping {
		a.stop()
		select {
		case <-a.done:
		case <-time.After(stopActorWait):
			m.log.Warn("actor did not stop in time", "session", a.key.sessionID)
		}
	}
	for _, inst := range starting {
		key := actorKey{sessionID: inst.SessionID, token: inst.Token}
		m.mu.Lock()
		a := m.actors[key]
		var adopt []*subscription
		for _, sub := range rebinds[inst.SessionID] {
			// still registered and not adopted onto an earlier instance this pass
			if live := m.subs[sub.id]; live == sub && sub.hostKey == (actorKey{}) {
				sub.hostKey = key
				sub.rehost() // the replacement may greet it again
				adopt = append(adopt, sub)
			}
		}
		m.mu.Unlock()
		if a == nil { // stopped again before this pass ran
			continue
		}
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			a.run() //nolint:contextcheck // the actor binds its context at spawn; requests cross the mailbox, not calls
		}()
		for _, sub := range adopt {
			select { // a fresh actor drains its mailbox promptly
			case a.mailbox <- msgAttach{sub: sub}:
			default:
				m.forget(sub)
				sub.close()
			}
		}
	}
	return nil
}

// orphanLocked detaches every subscription hosted by one actor key, so its
// session's next tracked instance can adopt them, returning who was detached.
// mu must be held.
func (m *Manager) orphanLocked(key actorKey) []*subscription {
	var out []*subscription
	for _, sub := range m.bySession[key.sessionID] {
		if sub.hostKey == key {
			sub.hostKey = actorKey{}
			out = append(out, sub)
		}
	}
	return out
}

// planRebinds collects the orphaned subscriptions per session. mu must be held.
func (m *Manager) planRebinds() map[string][]*subscription {
	out := make(map[string][]*subscription)
	for sessionID, set := range m.bySession {
		for _, sub := range set {
			if sub.hostKey == (actorKey{}) {
				out[sessionID] = append(out[sessionID], sub)
			}
		}
	}
	return out
}

// registerLocked indexes one subscription whose id is already assigned.
// mu must be held.
func (m *Manager) registerLocked(sub *subscription) {
	m.subs[sub.id] = sub
	set := m.bySession[sub.sessionID]
	if set == nil {
		set = make(map[int64]*subscription)
		m.bySession[sub.sessionID] = set
	}
	set[sub.id] = sub
}

// preferActor picks who serves a session with several live instances: an
// online actor beats a degraded one, then the oldest instance wins.
func preferActor(a, b *sessionActor) *sessionActor {
	rank := func(x *sessionActor) int {
		st := x.status.Load()
		switch st.State {
		case ChildOnline:
			return 0
		case ChildReconnecting:
			return 1
		default: // exited or unknown
			return 2
		}
	}
	if a == nil || rank(b) < rank(a) {
		return b
	}
	return a
}

// Subscribe registers one viewer on a session's stream. deliver receives
// pre-encoded frames and must not block indefinitely; onDrop fires when the
// subscription overflows, so the connection can be dropped fail-open.
func (m *Manager) Subscribe(sessionID string, deliver func([]byte), onDrop func()) (*Subscription, error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, ErrUnknownSession
	}

	m.mu.Lock()
	a := m.actorForLocked(sessionID)
	if a == nil {
		m.mu.Unlock()
		return nil, ErrUnknownSession
	}
	m.nextSubID++
	sub := newSubscription(m.nextSubID, sessionID, deliver, onDrop)
	m.registerLocked(sub)
	sub.hostKey = a.key // the actor serving this subscription, until a rebind moves it
	m.mu.Unlock()

	go sub.forward() // the queue serializes; frames only flow after attach

	select {
	case a.mailbox <- msgAttach{sub: sub}:
	default:
		m.forget(sub)
		sub.close()
		return nil, errors.New("session actor is busy; retry")
	}
	return &Subscription{s: sub}, nil
}

// Unsubscribe ends one subscription.
func (m *Manager) Unsubscribe(s *Subscription) {
	if s == nil || s.s == nil {
		return
	}
	m.detachSub(s.s)
}

// Resync re-pushes the init frame for an existing subscription, so a client
// can rebuild after losing state without resubscribing.
func (m *Manager) Resync(s *Subscription) {
	if s == nil || s.s == nil {
		return
	}
	sub := s.s
	m.mu.Lock()
	a := m.actors[sub.hostKey] // the actor serving this subscription, if any
	m.mu.Unlock()
	if a == nil {
		return
	}
	select {
	case a.mailbox <- msgSync{sub: sub}:
	default:
	}
}

// detachSub removes one subscription everywhere and closes it.
func (m *Manager) detachSub(sub *subscription) {
	m.mu.Lock()
	host := m.actors[sub.hostKey]
	m.forgetLocked(sub)
	m.mu.Unlock()
	sub.close()

	if host != nil {
		select { // best effort; a stopping actor needs no detach
		case host.mailbox <- msgDetach{sub: sub}:
		default:
		}
	}
}

// forget drops the subscription from the manager's indexes.
func (m *Manager) forget(sub *subscription) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.forgetLocked(sub)
}

func (m *Manager) forgetLocked(sub *subscription) {
	delete(m.subs, sub.id)
	if set := m.bySession[sub.sessionID]; set != nil {
		delete(set, sub.id)
		if len(set) == 0 {
			delete(m.bySession, sub.sessionID)
		}
	}
	sub.hostKey = actorKey{}
}

// actorForLocked returns the actor serving a session; mu must be held.
func (m *Manager) actorForLocked(sessionID string) *sessionActor {
	var best *sessionActor
	for key, a := range m.actors {
		if key.sessionID == sessionID {
			best = preferActor(best, a)
		}
	}
	return best
}

// TakeControl issues one force claim on user command for the session.
func (m *Manager) TakeControl(ctx context.Context, sessionID string) error {
	a := m.route(sessionID)
	if a == nil {
		return ErrUnknownSession
	}
	return a.takeControl(ctx)
}

// Entries pages through one session's retained committed entries. An empty
// before walks back from the newest entry; the cursor continues the walk.
func (m *Manager) Entries(ctx context.Context, sessionID, before string, limit int) ([]ctl.Entry, string, error) {
	a := m.route(sessionID)
	if a == nil {
		return nil, "", ErrUnknownSession
	}
	entries, cursor := a.entries(ctx, before, limit)
	return entries, cursor, nil
}

// route finds the actor serving a session under the manager lock.
func (m *Manager) route(sessionID string) *sessionActor {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.actorForLocked(sessionID)
}

// Sessions lists one row per known session, sorted by id: live actors carry
// their reconciled state, children add spawn facts, and children no longer
// tracked stand alone as exited or waiting rows.
func (m *Manager) Sessions() []Status {
	m.mu.Lock()
	actors := bulk.MapValuesSlice(m.actors)
	byPID := make(map[int]ChildRecord, len(m.children))
	for _, cp := range m.children {
		byPID[cp.rec.PID] = cp.rec
	}
	m.mu.Unlock()

	bySession := make(map[string]*Status, len(actors)+len(byPID))
	for _, a := range actors {
		st := *a.status.Load()
		st.SpawnedBy = SpawnedByExternal
		if rec, ok := byPID[st.PID]; ok {
			decorateChild(&st, rec)
		}
		bySession[st.SessionID] = &st
	}
	for _, rec := range byPID {
		if rec.SessionID == "" {
			continue // never served: the launch error told its story
		}
		if st, ok := bySession[rec.SessionID]; ok {
			decorateChild(st, rec)
			continue
		}
		st := childStatus(rec)
		bySession[rec.SessionID] = &st
	}
	out := make([]Status, 0, len(bySession))
	for _, st := range bySession {
		out = append(out, *st)
	}
	slices.SortFunc(out, func(a, b Status) int { return strings.Compare(a.SessionID, b.SessionID) })
	return out
}

// decorateChild folds a child record's spawn facts into a listing row.
func decorateChild(st *Status, rec ChildRecord) {
	st.SpawnedBy = SpawnedBySwarm
	st.Argv = rec.Argv
	st.LogPath = rec.LogPath
	st.ExitCode = rec.ExitCode
	st.LogTail = rec.LogTail
}

// childStatus renders a child no actor tracks: reaped ones keep their exit
// facts, running ones wait for a control socket to serve.
func childStatus(rec ChildRecord) Status {
	st := Status{
		SessionID: rec.SessionID,
		Workspace: rec.Workspace,
		PID:       rec.PID,
		State:     ChildReconnecting,
		Detail:    "waiting for its control socket",
		SpawnedBy: SpawnedBySwarm,
		Argv:      rec.Argv,
		LogPath:   rec.LogPath,
		ExitCode:  rec.ExitCode,
		LogTail:   rec.LogTail,
	}
	if !rec.ExitedAt.IsZero() {
		st.State = ChildExited
		st.Detail = rec.ExitNote
	}
	return st
}

// Subscription is the caller's handle on one stream registration.
type Subscription struct {
	s *subscription
}

// newSubscription builds the fanout-side subscription record.
func newSubscription(id int64, sessionID string, deliver func([]byte), onDrop func()) *subscription {
	return &subscription{
		id:        id,
		sessionID: sessionID,
		q:         make(chan []byte, subQueue),
		closed:    make(chan struct{}),
		deliver:   deliver,
		onDrop:    onDrop,
	}
}
