// Package fleet watches ajent's control registry and keeps one faithful,
// reconciled view per live instance: an actor goroutine per (session, token)
// holds the upstream connection, runs the watermark machine over its event
// stream and fans results out to any number of WebSocket viewers.
package fleet

import (
	"cmp"
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

// Ended-row bounds for the listing: at least maxExitedPinned ended sessions
// stay listed, and every exit inside endedKeepWindow stays too, however many
// launched since.
const (
	maxExitedPinned = 4
	endedKeepWindow = 2 * time.Hour
)

// ErrUnknownSession reports a subscribe or command naming no tracked instance.
var ErrUnknownSession = errors.New("unknown session")

// Options tunes the manager, zero values take production defaults.
type Options struct {
	Log          *slog.Logger
	PollInterval time.Duration // registry watch cadence, about once a second
	BackoffBase  time.Duration // actor redial base
	BackoffMax   time.Duration // actor redial cap
	// ParkIdleWindow is how long a session's provider must be quiet before
	// its parked prompts flush, zero takes the 1-minute default.
	ParkIdleWindow time.Duration

	// Owned names sessions swarm spawned, they force-claim the seat as holder
	// swarm at attach. External sessions observe until a write or an explicit
	// take-control, so a human --attach is never displaced without asking.
	Owned func(inst ctl.Instance) bool

	// Discover reads the live registry, client.DiscoverLive when unset.
	Discover func() ([]ctl.Instance, error)

	// Child launching: AjentBin and ChildrenDir must both be set for Launch
	// to work. ChildStore persistence enables orphan re-adoption across
	// restarts and retains external sessions in the listing, KillOnExit opts
	// into terminating running children at Stop.
	AjentBin    string
	ChildrenDir string
	ChildStore  ChildStore
	KillOnExit  bool
	LaunchWait  time.Duration // spawn-to-socket deadline
	AwaitPoll   time.Duration // registry poll cadence while awaiting that socket
	ExitGrace   time.Duration // /exit settles before SIGTERM
	TermGrace   time.Duration // SIGTERM before SIGKILL

	// NoNaming turns off auto-titling: unnamed sessions never get the one-shot
	// labeler run over their first prompt, and no display title is stored.
	NoNaming bool

	// TitleStore persists swarm-side display titles, nil disables storing them
	// and every listing falls back to agent names, paths and short ids.
	TitleStore TitleStore

	// SettingStore persists swarm-level settings (the titling model today),
	// nil keeps every setting at its default and refuses writes.
	SettingStore SettingsStore

	// RecallStore persists the workspace-wide recall mirror of typed submits,
	// nil disables recording, and listings then serve ajent's own recall
	// sources alone.
	RecallStore RecallStore

	// AckStore persists attention acknowledgments, so one device's check-off
	// settles the row for every device and survives restarts, nil keeps every
	// item unacknowledged and refuses writes.
	AckStore AckStore
}

// Manager tracks every live ajent instance and owns its actors' lifecycles.
type Manager struct {
	log             *slog.Logger
	pollInterval    time.Duration
	dialBackoffBase time.Duration
	dialBackoffMax  time.Duration
	parkWindow      time.Duration
	optsOwned       func(ctl.Instance) bool
	discover        func() ([]ctl.Instance, error)

	bin          string
	childrenDir  string
	childStore   ChildStore
	killOnExit   bool
	launchWait   time.Duration
	awaitPoll    time.Duration
	exitGrace    time.Duration
	termGrace    time.Duration
	noNaming     bool
	titleStore   TitleStore
	settingStore SettingsStore
	recallStore  RecallStore
	ackStore     AckStore

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
	childBySession map[string]*childProc
	externals      map[int]ChildRecord       // retained external session rows, by pid
	named          map[string]struct{}       // sessions whose auto-name already ran
	titles         map[string]string         // cached display titles, mirrored from TitleStore
	titleModel     string                    // cached titling model, mirrored from SettingStore
	dialogAcks     map[dialogAckKey]struct{} // cached settled dialogs, mirrored from AckStore
	turnAcks       map[string]int64          // cached acknowledged turn ends, mirrored from AckStore
	releaseFloors  map[string]time.Time      // provider -> newest release instant, "" unattributed
}

// New builds a manager, Start begins the registry watch.
func New(opts Options) *Manager {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	m := &Manager{
		log:             opts.Log,
		pollInterval:    cmpOr(opts.PollInterval, pollEvery),
		dialBackoffBase: cmpOr(opts.BackoffBase, dialBackoffBase),
		dialBackoffMax:  cmpOr(opts.BackoffMax, dialBackoffMax),
		parkWindow:      cmpOr(opts.ParkIdleWindow, parkIdleWindow),
		optsOwned:       opts.Owned,
		discover:        opts.Discover,
		bin:             opts.AjentBin,
		childrenDir:     opts.ChildrenDir,
		childStore:      opts.ChildStore,
		killOnExit:      opts.KillOnExit,
		launchWait:      cmpOr(opts.LaunchWait, launchWaitDefault),
		awaitPoll:       cmpOr(opts.AwaitPoll, awaitPollEvery),
		exitGrace:       cmpOr(opts.ExitGrace, exitGraceDefault),
		termGrace:       cmpOr(opts.TermGrace, termGraceDefault),
		noNaming:        opts.NoNaming,
		titleStore:      opts.TitleStore,
		settingStore:    opts.SettingStore,
		recallStore:     opts.RecallStore,
		ackStore:        opts.AckStore,
		actors:          make(map[actorKey]*sessionActor),
		subs:            make(map[int64]*subscription),
		bySession:       make(map[string]map[int64]*subscription),
		nudge:           make(chan struct{}, 1),
		children:        make(map[int]*childProc),
		childBySession:  make(map[string]*childProc),
		externals:       make(map[int]ChildRecord),
		named:           make(map[string]struct{}),
		titles:          make(map[string]string),
		dialogAcks:      make(map[dialogAckKey]struct{}),
		turnAcks:        make(map[string]int64),
		releaseFloors:   make(map[string]time.Time),
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
	if m.titleStore != nil {
		m.loadTitles(ctx)
	}
	if m.settingStore != nil {
		m.loadSettings(ctx)
	}
	if m.ackStore != nil {
		m.loadAcks(ctx)
	}
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
		m.cancel()
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
		if err := m.diff(); err != nil { //nolint:contextcheck // actors bind ctx at spawn, not per call
			m.log.Warn("discovery failed", "err", err)
			interval = min(interval*2, pollErrorMax)
			continue
		}
		interval = m.pollInterval
	}
}

// diff starts actors for new instances and stops those whose record left,
// retaining first-sighted externals so their rows outlive tracking.
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
			if st := a.status.Load(); st.emptyRun() {
				// without this stamp, a later settle finds nothing and keeps the row
				m.markEmptyRunLocked(st.PID)
			}
		}
	}
	// their subscribers wait for a replacement instance to adopt them
	for _, a := range stopping {
		gone = append(gone, m.orphanLocked(a.key)...)
	}

	var starting []ctl.Instance
	var unrecorded []ctl.Instance
	for _, inst := range live {
		key := actorKey{sessionID: inst.SessionID, token: inst.Token}
		if _, tracked := m.actors[key]; tracked {
			continue
		}
		a := newSessionActor(m, inst)
		m.actors[key] = a
		starting = append(starting, inst)
		if inst.PID > 0 && inst.SessionID != "" && !m.recordedLocked(inst.PID) {
			unrecorded = append(unrecorded, inst)
		}
	}
	rebinds := make(map[string][]*subscription)
	for sessionID, set := range m.bySession {
		orphans := bulk.SliceFilter(func(sub *subscription) bool { return sub.hostKey == (actorKey{}) },
			bulk.MapValuesSlice(set))
		if len(orphans) > 0 {
			rebinds[sessionID] = orphans
		}
	}
	m.mu.Unlock()

	// publish to them here: it cannot race an attach queued on the actor
	for _, sub := range gone {
		if sub.retire() {
			sub.fireDrop()
		}
	}

	for _, inst := range unrecorded {
		m.retainExternal(inst)
	}

	for _, a := range stopping {
		// a.inst is actor-confined, the retiring row carries its current facts
		m.markExternalGone(a)
		a.cancel() // context.CancelFunc is idempotent
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
			a.run() //nolint:contextcheck // the actor binds ctx at spawn, not per call
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

// recordedLocked reports whether a child record already covers the pid, so
// first-sighting retention can skip it. mu must be held.
func (m *Manager) recordedLocked(pid int) bool {
	if _, ok := m.children[pid]; ok {
		return true
	}
	_, ok := m.externals[pid]
	return ok
}

// retainExternal persists one external instance's row at its first sighting,
// so the listing keeps it once tracking ends or the service restarts. The
// store dedupes by pid, so repeated discovery passes never duplicate it.
func (m *Manager) retainExternal(inst ctl.Instance) {
	rec := ChildRecord{
		PID:         inst.PID,
		SessionID:   inst.SessionID,
		SessionName: inst.SessionName,
		Workspace:   inst.Workspace,
		StartedAt:   inst.Started(),
		Origin:      SpawnedByExternal,
	}
	if rec.StartedAt.IsZero() {
		rec.StartedAt = time.Now()
	}
	if m.childStore != nil {
		id, _, err := m.childStore.CreateChildIfAbsent(m.storeCtx, rec)
		if err != nil {
			m.log.Warn("external session not persisted", "pid", rec.PID, "err", err)
		}
		rec.ID = id
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.recordedLocked(rec.PID) { // a pass before us, or a spawn, covered the pid
		return
	}
	m.externals[rec.PID] = rec
}

// markExternalGone ends an external session's retained row once its record
// left discovery: swarm never reaped that process, so the exit code stays
// unset. A run the retiring actor proves empty drops instead, mirroring the
// transcript ajent deleted at exit. A pass racing shutdown skips the marking,
// so a restart never lists still-running externals as ended.
func (m *Manager) markExternalGone(a *sessionActor) {
	if m.ctx.Err() != nil {
		return
	}
	st := a.status.Load()
	m.mu.Lock()
	rec, ok := m.externals[st.PID]
	if !ok || !rec.ExitedAt.IsZero() {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	if st.emptyRun() && m.dropChild(rec) {
		return
	}
	rec.ExitedAt = time.Now()
	rec.ExitNote = "ended on its own"
	m.mu.Lock()
	m.externals[rec.PID] = rec
	m.mu.Unlock()

	m.persistChild(rec)
	m.log.Info("external session left the control registry", "pid", rec.PID, "session", rec.SessionID)
}

// orphanLocked detaches every subscription hosted by one actor key, so its
// session's next tracked instance can adopt them, returning who was detached.
// mu must be held.
func (m *Manager) orphanLocked(key actorKey) []*subscription {
	out := bulk.SliceFilter(func(sub *subscription) bool { return sub.hostKey == key },
		bulk.MapValuesSlice(m.bySession[key.sessionID]))
	for _, sub := range out {
		sub.hostKey = actorKey{}
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

// actorForLocked returns the actor serving a session, mu must be held. With
// several live instances an online actor beats a degraded one.
func (m *Manager) actorForLocked(sessionID string) *sessionActor {
	rank := func(a *sessionActor) int {
		switch a.status.Load().State {
		case ChildOnline:
			return 0
		case ChildReconnecting:
			return 1
		default: // exited or unknown
			return 2
		}
	}
	var best *sessionActor
	for key, a := range m.actors {
		if key.sessionID != sessionID {
			continue
		}
		if best == nil || rank(a) < rank(best) {
			best = a
		}
	}
	return best
}

// Subscribe registers one viewer on a session's stream. deliver receives
// pre-encoded frames and must not block indefinitely, onDrop fires when the
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
	sub := &subscription{
		id:        m.nextSubID,
		sessionID: sessionID,
		q:         make(chan []byte, subQueue),
		closed:    make(chan struct{}),
		deliver:   deliver,
		onDrop:    onDrop,
	}
	m.registerLocked(sub)
	sub.hostKey = a.key // the actor serving this subscription, until a rebind moves it
	m.mu.Unlock()

	go sub.forward() // the queue serializes, frames only flow after attach

	select {
	case a.mailbox <- msgAttach{sub: sub}:
	default:
		m.forget(sub)
		sub.close()
		return nil, errors.New("session actor is busy; retry")
	}
	return &Subscription{s: sub}, nil
}

// Unsubscribe ends one subscription everywhere and closes it.
func (m *Manager) Unsubscribe(s *Subscription) {
	if s == nil {
		return
	}
	sub := s.s
	m.mu.Lock()
	host := m.actors[sub.hostKey]
	m.forgetLocked(sub)
	m.mu.Unlock()
	sub.close()

	if host != nil {
		select { // best effort, a stopping actor needs no detach
		case host.mailbox <- msgDetach{sub: sub}:
		default:
		}
	}
}

// Resync re-pushes the init frame for an existing subscription, so a client
// can rebuild after losing state without resubscribing.
func (m *Manager) Resync(s *Subscription) {
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

// TakeControl issues one force claim on user command for the session.
func (m *Manager) TakeControl(ctx context.Context, sessionID string) error {
	a := m.route(sessionID)
	if a == nil {
		return ErrUnknownSession
	}
	err, _ := mailboxCall(ctx, a, func(reply chan error) actorMsg { return msgTakeControl{reply: reply} })
	return err
}

// Entries pages through one session's retained committed entries. An empty
// before walks back from the newest entry, the cursor continues the walk.
func (m *Manager) Entries(ctx context.Context, sessionID, before string, limit int) ([]ctl.Entry, string, error) {
	a := m.route(sessionID)
	if a == nil {
		return nil, "", ErrUnknownSession
	}
	page, err := mailboxCall(ctx, a, func(reply chan entriesPage) actorMsg {
		return msgEntries{before: before, limit: limit, reply: reply}
	})
	if err != nil { // a shutdown or timeout serves an empty page
		return nil, "", nil
	}
	return page.entries, page.cursor, nil
}

// route finds the actor serving a session under the manager lock.
func (m *Manager) route(sessionID string) *sessionActor {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.actorForLocked(sessionID)
}

// Sessions lists every known session, one row each: live rows first,
// sorted by session id then pid, followed by recently ended ones most recent
// first. Twin instances serving one session list twice, told apart by pid,
// external sessions keep their row after they end.
func (m *Manager) Sessions() []Status {
	m.mu.Lock()
	actors := bulk.MapValuesSlice(m.actors)
	byPID := make(map[int]ChildRecord, len(m.children)+len(m.externals))
	for _, cp := range m.children {
		byPID[cp.rec.PID] = cp.rec
	}
	for pid, rec := range m.externals { // a pid is never recorded twice
		if _, ok := byPID[pid]; !ok {
			byPID[pid] = rec
		}
	}
	m.mu.Unlock()

	recs := bulk.MapValuesSlice(byPID)
	slices.SortFunc(recs, func(a, b ChildRecord) int { return b.StartedAt.Compare(a.StartedAt) })

	rows := make([]*Status, 0, len(actors)+len(recs))
	byInstancePID := make(map[int]*Status, len(actors))
	tracked := make(map[string]struct{}, len(actors))
	for _, a := range actors {
		st := *a.status.Load()
		st.SpawnedBy = SpawnedByExternal
		rows = append(rows, &st)
		if st.PID > 0 {
			byInstancePID[st.PID] = &st
		}
		tracked[st.SessionID] = struct{}{}
	}
	listed := make(map[string]struct{}, len(recs))
	for _, rec := range recs { // newest first: the latest record describes the session
		if rec.SessionID == "" {
			continue // never served: the launch error told its story
		}
		if st, ok := byInstancePID[rec.PID]; ok && st.SessionID == rec.SessionID {
			decorateChild(st, rec) // an actor keeps only its own spawn facts
			continue
		}
		// its session has a row already: the live actor or an earlier record
		if _, ok := tracked[rec.SessionID]; ok {
			continue
		}
		if _, ok := listed[rec.SessionID]; ok {
			continue
		}
		row := childStatus(rec)
		rows = append(rows, &row)
		listed[rec.SessionID] = struct{}{}
	}

	alive := make([]Status, 0, len(rows))
	ended := make([]Status, 0, len(rows))
	for _, st := range rows {
		// titleFor takes the manager lock, so labels fold in here
		st.Title = m.titleFor(st.SessionID)
		if st.State == ChildExited {
			ended = append(ended, *st)
		} else {
			alive = append(alive, *st)
		}
	}
	slices.SortFunc(alive, func(a, b Status) int {
		if c := strings.Compare(a.SessionID, b.SessionID); c != 0 {
			return c
		}
		return cmp.Compare(a.PID, b.PID) // twin instances keep a stable order
	})
	slices.SortFunc(ended, func(a, b Status) int {
		if a.ExitedAt != b.ExitedAt { // most recent first
			return cmp.Compare(b.ExitedAt, a.ExitedAt)
		}
		if c := strings.Compare(a.SessionID, b.SessionID); c != 0 {
			return c
		}
		return cmp.Compare(a.PID, b.PID)
	})
	// everything from the recent window stays listed, older exits only fill up to the pinned minimum
	kept := min(len(ended), maxExitedPinned)
	for kept < len(ended) && time.Since(time.UnixMilli(ended[kept].ExitedAt)) <= endedKeepWindow {
		kept++
	}
	return append(alive, ended[:kept]...)
}

// MaxDigestText caps one digest reason or preview, mirroring the rewind
// label cap: display text, never a data channel.
const MaxDigestText = 160

var digestFlatten = strings.NewReplacer("\r", " ", "\n", " ")

// digestText flattens one display string to a single bounded line.
func digestText(s string) string {
	s = digestFlatten.Replace(s)
	runes := []rune(s)
	if len(runes) > MaxDigestText {
		return string(runes[:MaxDigestText]) + "…"
	}
	return s
}

// Attention is one live session's row of the cheap focus feed.
type Attention struct {
	digestFacts

	// Acknowledgment facts from the server-side ledger: whether this row's
	// oldest open dialog is settled, and the session's acknowledged turn end.
	AckedDialog bool  `json:"ackedDialog,omitempty"`
	AckedTurn   int64 `json:"ackedTurn,omitempty"` // unix milliseconds

	// Derived attention, clients render these verbatim. Since drives the
	// needs queue's oldest-wait order (a dialog's wait or a turn end).
	Kind   string `json:"kind"`
	Reason string `json:"reason,omitempty"`
	Since  int64  `json:"since,omitempty"` // unix milliseconds
}

// servingStatuses snapshots the listing row of every actor whose session
// still serves, the best-effort listing feeds filter on it.
func (m *Manager) servingStatuses() []*Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Status, 0, len(m.actors))
	for _, a := range m.actors {
		if st := a.status.Load(); st.serving() {
			out = append(out, st)
		}
	}
	return out
}

// Attention summarizes every live session from its actor's reconciled view,
// one row each, sorted by session id. Exited sessions drop out, a degraded
// connection keeps its last known facts until tracking ends. Kind, reason and
// wait are derived server-side against the acknowledgment ledger, so every
// device renders one attention state.
func (m *Manager) Attention() []Attention {
	statuses := m.servingStatuses()
	facts := m.ackFactsFor(statuses)

	out := make([]Attention, 0, len(statuses))
	for i, st := range statuses {
		out = append(out, deriveAttention(st, facts[i]))
	}
	slices.SortFunc(out, func(a, b Attention) int { return strings.Compare(a.SessionID, b.SessionID) })
	return out
}

// ProviderOf splits a model key into its provider half: "anthropic/claude-x"
// reports anthropic. A key without the prefix reports the empty string.
func ProviderOf(model string) string {
	provider, _, ok := strings.Cut(model, "/")
	if !ok || provider == "" {
		return ""
	}
	return provider
}

// providerTouches reports whether a fact keyed by one provider applies to
// another's gate.
func providerTouches(key, provider string) bool {
	return key == "" || provider == "" || key == provider
}

// ProviderBusyAt reports the newest agent activity among sessions sharing one
// provider: now while a turn runs, otherwise its most recent turn end. The
// zero time means nothing is known to have worked.
func (m *Manager) ProviderBusyAt(provider string) time.Time {
	var last time.Time
	for _, st := range m.servingStatuses() {
		if !providerTouches(ProviderOf(st.Model), provider) {
			continue // another provider's session, its facts stay on that gate
		}
		if at := st.busyAt(); at.After(last) {
			last = at
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for p, floor := range m.releaseFloors {
		if providerTouches(p, provider) && floor.After(last) {
			last = floor
		}
	}
	return last
}

// ClaimRelease reports whether one of a provider's idle points is free to
// take once window has passed since the last release into it. A true answer
// marks this instant as busy for the provider, so callers must release work
// only after claiming.
func (m *Manager) ClaimRelease(provider string, window time.Duration) bool {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	for p, floor := range m.releaseFloors {
		if providerTouches(p, provider) && now.Sub(floor) < window {
			return false
		}
	}
	m.releaseFloors[provider] = now
	return true
}

// NoteRelease records a release that did not gate on idleness, so the
// provider's idle gates treat it as busy until the released turn reports
// facts of its own.
func (m *Manager) NoteRelease(provider string) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	if now.After(m.releaseFloors[provider]) {
		m.releaseFloors[provider] = now
	}
}

// decorateChild folds a child record's spawn facts into a listing row.
func decorateChild(st *Status, rec ChildRecord) {
	st.SpawnedBy = rec.spawnedBy()
	st.Argv = rec.Argv
	st.LogPath = rec.LogPath
	st.ExitCode = rec.ExitCode
	st.LogTail = rec.LogTail
	if !rec.ExitedAt.IsZero() {
		st.ExitedAt = rec.ExitedAt.UnixMilli()
	}
}

// childStatus renders a child no actor tracks: reaped ones keep their exit
// facts, running ones wait for a control socket to serve. Externals carry
// their discovery facts, so an ended one reads as it served.
func childStatus(rec ChildRecord) Status {
	st := Status{
		digestFacts: digestFacts{SessionID: rec.SessionID, PID: rec.PID},
		Name:        rec.SessionName,
		Workspace:   rec.Workspace,
		State:       ChildReconnecting,
		Detail:      "waiting for its control socket",
	}
	decorateChild(&st, rec)
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
