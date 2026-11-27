package fleet

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/session"
)

// Chain states, one per record. waiting through delivering are live and carry
// a pump, the rest are terminal.
const (
	ChainWaiting    = "waiting"
	ChainFinal      = "final"
	ChainHandoff    = "handoff"
	ChainDelivering = "delivering"
	ChainDone       = "done"
	ChainFailed     = "failed"
	ChainCanceled   = "canceled"
)

// Chain bounds and pacing. The failed-notice window bounds how long a
// terminal failure keeps folding into the digest, and the record TTL bounds
// how long terminal records answer reads at all.
const (
	maxChains         = 16
	chainPromptMax    = 1 << 20 // mirrors the API body cap
	chainPendingIDMax = 128
	maxComposedRunes  = 8000
	chainFailedNotice = time.Minute
	chainRecordTTL    = 10 * time.Minute
	chainPageEntries  = 200
	chainCollectPages = 3
	chainDefaultPoll  = time.Second
	chainLineHeader   = "Prior session last message:"
	chainLineSep      = "\n\n----\n\n"
)

// Chain lifecycle policies. A restored chain owes its endpoints the
// adoption grace before a missing session reads as an exit, since discovery
// and child re-adoption race startup.
const (
	chainAdoptGraceDefault = 30 * time.Second
	chainSweepEvery        = time.Hour
)

// Chain refusals, the API layer maps each onto its coded response.
var (
	ErrTooManyChains   = errors.New("too many active chains")
	ErrChainConflict   = errors.New("session already chained")
	ErrChainCycle      = errors.New("chain would form a cycle")
	ErrChainInvalid    = errors.New("invalid chain")
	ErrChainParentGone = errors.New("the parent session is not live, its final prompt cannot run")
	ErrUnknownChain    = errors.New("unknown chain")
	ErrChainEditing    = errors.New("chain is past its edit point")
)

// ChainStore persists the chain registry, so chains survive service
// restarts and re-arm their pumps. nil keeps chains ephemeral.
type ChainStore interface {
	// SaveChain upserts one chain row by id.
	SaveChain(ctx context.Context, ch Chain) error
	// DeleteChain removes one chain row, unknown ids stay clean.
	DeleteChain(ctx context.Context, id string) error
	// LoadChains returns every stored chain row, oldest first.
	LoadChains(ctx context.Context) ([]Chain, error)
}

// Chain is one queued parent-to-child handoff, the wire record verbatim.
// Records persist through the ChainStore and re-arm after a restart.
type Chain struct {
	ID          string `json:"id"`
	ParentID    string `json:"parentId"`
	ChildID     string `json:"childId"`
	FinalPrompt string `json:"finalPrompt,omitempty"` // empty runs the child prompt alone
	ChildPrompt string `json:"childPrompt"`
	PendingID   string `json:"pendingId,omitempty"` // rides the child submit
	FinalAt     int64  `json:"finalAt,omitempty"`   // unix ms the final submit was issued
	State       string `json:"state"`
	Reason      string `json:"reason,omitempty"` // failure cause
	Mark        string `json:"mark,omitempty"`   // the final prompt's committed entry id
	CreatedAt   int64  `json:"createdAt"`        // unix milliseconds
	UpdatedAt   int64  `json:"updatedAt"`        // unix milliseconds
}

// ChainParams names one chain's prompts, the parent rides the call site and
// edits leave it fixed.
type ChainParams struct {
	FinalPrompt string
	ChildPrompt string
	PendingID   string
}

// chainRun is one registered chain beside its pump's private progress.
// Manager.mu guards the whole struct.
type chainRun struct {
	ch         Chain
	seq        uint64 // registry insertion order, breaks CreatedAt ties
	composed   string // the delivering line, built at handoff
	refusedAt  int64  // unix ms the last retryable refusal landed
	restoredAt int64  // unix ms the pump re-armed after a restart, 0 live
	cancel     context.CancelFunc
	done       chan struct{} // closed when the pump goroutine exits
}

// nextChainSeqLocked hands out the next registry insertion number, restored
// chains keep their stored order. mu must be held.
func (m *Manager) nextChainSeqLocked() uint64 {
	m.chainSeq++
	return m.chainSeq
}

// chainTerminal reports whether a state finished its work and keeps no pump.
func chainTerminal(state string) bool {
	switch state {
	case ChainDone, ChainFailed, ChainCanceled:
		return true
	}
	return false
}

// chainLive reports whether the state still carries a pump.
func chainLive(state string) bool { return !chainTerminal(state) }

// chainFinalPendingID names the pending id a final prompt submits under, the
// id its committed entry carries so collection rebinds to that entry alone.
func chainFinalPendingID(chainID string) string {
	return "chain-" + chainID
}

// CreateChain validates and registers one chain, then starts its pump and
// names the child from its start prompt, the same one-shot labeler a parked
// first prompt drives. The parent must be live or recorded, the child live,
// no active chain may already target the child, and the link may not close a
// cycle.
func (m *Manager) CreateChain(ctx context.Context, parent, child string, p ChainParams) (Chain, error) {
	p.ChildPrompt = strings.TrimSpace(p.ChildPrompt)
	if strings.TrimSpace(parent) == "" || strings.TrimSpace(child) == "" ||
		parent == child || p.ChildPrompt == "" ||
		len(p.FinalPrompt) > chainPromptMax || len(p.ChildPrompt) > chainPromptMax ||
		len(p.PendingID) > chainPendingIDMax {
		return Chain{}, ErrChainInvalid
	}
	if m.route(child) == nil {
		return Chain{}, ErrUnknownSession
	}
	parentLive := m.route(parent) != nil
	if !parentLive && !m.savedKnown(parent) {
		return Chain{}, ErrUnknownSession
	}
	if p.FinalPrompt != "" && !parentLive {
		return Chain{}, ErrChainParentGone
	}

	m.mu.Lock()
	live := 0
	for _, run := range m.chains {
		if chainLive(run.ch.State) {
			live++
		}
	}
	if live >= maxChains {
		m.mu.Unlock()
		return Chain{}, ErrTooManyChains
	}
	for _, run := range m.chains {
		if chainLive(run.ch.State) && run.ch.ChildID == child {
			m.mu.Unlock()
			return Chain{}, ErrChainConflict
		}
	}
	if m.chainCycleLocked(parent, child) {
		m.mu.Unlock()
		return Chain{}, ErrChainCycle
	}
	m.pruneChainsLocked()

	var seed [4]byte
	rand.Read(seed[:]) // crypto/rand never fails, nothing sensible to answer anyway
	now := time.Now().UnixMilli()
	m.chainSeq++
	run := &chainRun{seq: m.chainSeq, ch: Chain{
		ID:          "chn_" + hex.EncodeToString(seed[:]),
		ParentID:    parent,
		ChildID:     child,
		FinalPrompt: p.FinalPrompt,
		ChildPrompt: p.ChildPrompt,
		PendingID:   p.PendingID,
		State:       ChainWaiting,
		CreatedAt:   now,
		UpdatedAt:   now,
	}}
	m.chains[run.ch.ID] = run
	m.persistChainLocked(run.ch)
	created := run.ch
	//nolint:contextcheck // pumps ride the manager context, never the request
	m.startPumpLocked(m.ctx, run)
	m.mu.Unlock()

	// the queued child names from its start prompt at once, not at handoff;
	// the namer itself defers to a stored title
	//nolint:contextcheck // naming rides the manager context, never the request
	if a := m.route(child); a != nil {
		m.maybeNameSessionFrom(a, created.ChildPrompt)
	}
	return created, nil
}

// chainCycleLocked reports whether chaining parent behind child closes a
// loop: walking active chains backward from the parent, any hop onto the
// child means the new link would feed itself. mu must be held.
func (m *Manager) chainCycleLocked(parent, child string) bool {
	cur := parent
	for range len(m.chains) {
		var next string
		found := false
		for _, run := range m.chains {
			if chainLive(run.ch.State) && run.ch.ChildID == cur {
				next, found = run.ch.ParentID, true
				break
			}
		}
		if !found {
			return false
		}
		if next == child {
			return true
		}
		cur = next
	}
	return false
}

// pruneChainsLocked drops terminal records past their digest retention and
// deletes their rows, so the registry and the store stay bounded together.
// mu must be held.
func (m *Manager) pruneChainsLocked() {
	cutoff := time.Now().Add(-chainRecordTTL).UnixMilli()
	for id, run := range m.chains {
		if !chainTerminal(run.ch.State) || run.ch.UpdatedAt >= cutoff {
			continue
		}
		delete(m.chains, id)
		if m.chainStore != nil {
			if err := m.chainStore.DeleteChain(m.storeCtx, id); err != nil {
				m.log.Warn("chain row not deleted", "chain", id, "err", err)
			}
		}
	}
}

// chainEditable reports whether a state still accepts prompt edits.
func chainEditable(state string) bool {
	return state == ChainWaiting || state == ChainFinal
}

// stopPump cancels one chain's pump and waits out its final tick, so an edit
// or cancel never interleaves with an in-flight submit. Callers hold
// chainEditMu and must not hold mu.
func (m *Manager) stopPump(run *chainRun) {
	run.cancel()
	<-run.done
}

// UpdateChain edits one chain's prompts: the pump stops for the edit, so an
// in-flight submit settles first, then restarts under the same id. Allowed
// only in waiting or final. A final-state edit keeps that turn's progress,
// so the submitted prompt never runs twice and only the child prompt may
// change there.
func (m *Manager) UpdateChain(ctx context.Context, id string, p ChainParams) (Chain, error) {
	p.ChildPrompt = strings.TrimSpace(p.ChildPrompt)
	if p.ChildPrompt == "" || len(p.FinalPrompt) > chainPromptMax ||
		len(p.ChildPrompt) > chainPromptMax {
		return Chain{}, ErrChainInvalid
	}

	m.chainEditMu.Lock()
	defer m.chainEditMu.Unlock()
	m.mu.Lock()
	run, ok := m.chains[id]
	if !ok {
		m.mu.Unlock()
		return Chain{}, ErrUnknownChain
	}
	if !chainEditable(run.ch.State) {
		m.mu.Unlock()
		return Chain{}, ErrChainEditing
	}
	if run.ch.State == ChainFinal && p.FinalPrompt != run.ch.FinalPrompt {
		m.mu.Unlock()
		return Chain{}, ErrChainEditing // the final prompt already runs
	}
	if run.ch.State != ChainFinal && p.FinalPrompt != "" &&
		m.actorForLocked(run.ch.ParentID) == nil {
		m.mu.Unlock()
		return Chain{}, ErrChainParentGone
	}
	run.cancel() // stop the pump before the edit, an in-flight submit settles first
	m.mu.Unlock()
	m.stopPump(run)

	m.mu.Lock()
	defer m.mu.Unlock()
	if run, ok = m.chains[id]; !ok {
		return Chain{}, ErrUnknownChain
	}
	if !chainEditable(run.ch.State) {
		// the stopped pump's last tick moved the chain past its edit point
		return Chain{}, ErrChainEditing
	}
	if run.ch.State == ChainFinal && p.FinalPrompt != run.ch.FinalPrompt {
		return Chain{}, ErrChainEditing
	}
	run.ch.ChildPrompt = p.ChildPrompt
	if run.ch.State != ChainFinal {
		run.ch.FinalPrompt = p.FinalPrompt
		run.ch.FinalAt = 0
		run.ch.State = ChainWaiting
		run.ch.Mark = ""
	}
	// restoredAt survives an edit: recovery still owes the endpoints the
	// adoption grace after a restart
	m.persistChainLocked(run.ch)
	//nolint:contextcheck // pumps ride the manager context, never the request
	m.startPumpLocked(m.ctx, run)
	return run.ch, nil
}

// pausedChains holds the pumps a session stop parked: their records stay
// live, but no tick can submit while the stop settles.
type pausedChains struct {
	editMu *sync.Mutex
	runs   []*chainRun
}

// pauseChainsForSession stops every live pump in the chain component touching
// one session and holds the edit lock, so neither the endpoint's handoff nor a
// stacked link behind it can race the stop itself. A nil answer means no chain
// cares and the stop proceeds without the lock.
func (m *Manager) pauseChainsForSession(sessionID string) *pausedChains {
	m.chainEditMu.Lock()
	m.mu.Lock()
	selected := make([]*chainRun, 0, len(m.chains))
	chosen := make(map[string]struct{})
	frontier := []string{sessionID}
	for len(frontier) > 0 {
		cur := frontier[0]
		frontier = frontier[1:]
		for _, run := range m.chains {
			if _, ok := chosen[run.ch.ID]; ok || !chainLive(run.ch.State) {
				continue
			}
			if run.ch.ParentID != cur && run.ch.ChildID != cur {
				continue
			}
			chosen[run.ch.ID] = struct{}{}
			selected = append(selected, run)
			frontier = append(frontier, run.ch.ParentID, run.ch.ChildID)
		}
	}
	slices.SortFunc(selected, func(a, b *chainRun) int { return cmp.Compare(a.seq, b.seq) })
	for _, run := range selected {
		run.cancel()
	}
	m.mu.Unlock()
	if len(selected) == 0 {
		m.chainEditMu.Unlock()
		return nil
	}
	for _, run := range selected {
		<-run.done
	}
	return &pausedChains{editMu: &m.chainEditMu, runs: selected}
}

// resumePausedChains re-arms pumps a refused stop parked, leaving their
// records exactly as they stood.
func (m *Manager) resumePausedChains(paused *pausedChains) {
	if paused == nil {
		return
	}
	defer paused.editMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, run := range paused.runs {
		if runLive, ok := m.chains[run.ch.ID]; ok && runLive == run && chainLive(run.ch.State) {
			m.startPumpLocked(m.ctx, run)
		}
	}
}

// landPausedChains fails the chains a confirmed stop touched. A stopped
// endpoint never hands off or receives, and each landing cascades to the links
// stacked behind it.
func (m *Manager) landPausedChains(paused *pausedChains, sessionID string) {
	if paused == nil {
		return
	}
	defer paused.editMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, run := range paused.runs {
		if cur, ok := m.chains[run.ch.ID]; !ok || cur != run || !chainLive(run.ch.State) {
			continue
		}
		reason := "child stopped"
		if run.ch.ParentID == sessionID {
			reason = "parent stopped"
		}
		m.landChainLocked(run, ChainFailed, reason)
	}
}

// CancelChain stops one chain before delivery, waiting out any in-flight
// submit so a canceled chain never delivers a line that raced the cancel.
// Terminal records answer clean. A canceled link breaks the sequence behind
// it, the tail lands canceled with it.
func (m *Manager) CancelChain(_ context.Context, id string) error {
	m.chainEditMu.Lock()
	defer m.chainEditMu.Unlock()
	m.mu.Lock()
	run, ok := m.chains[id]
	if !ok {
		m.mu.Unlock()
		return ErrUnknownChain
	}
	if chainTerminal(run.ch.State) {
		m.mu.Unlock()
		return nil
	}
	run.cancel()
	m.mu.Unlock()
	m.stopPump(run)

	m.mu.Lock()
	defer m.mu.Unlock()
	if run, ok = m.chains[id]; ok && !chainTerminal(run.ch.State) {
		m.landChainLocked(run, ChainCanceled, "")
	}
	return nil
}

// Chain reads one registered record by id, false when no such chain holds.
func (m *Manager) Chain(id string) (Chain, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run, ok := m.chains[id]
	if !ok {
		return Chain{}, false
	}
	return run.ch, true
}

// ChainList snapshots every registered record, oldest first.
func (m *Manager) ChainList() []Chain {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Chain, 0, len(m.chains))
	for _, run := range m.chains {
		out = append(out, run.ch)
	}
	slices.SortStableFunc(out, func(a, b Chain) int {
		if a.CreatedAt != b.CreatedAt {
			return int(a.CreatedAt - b.CreatedAt)
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

// persistChainLocked writes one chain record through to the store under the
// registry lock, so persisted states land in order. Best effort: a wedged
// store logs and leaves the registry authoritative. mu must be held.
func (m *Manager) persistChainLocked(ch Chain) {
	if m.chainStore == nil {
		return
	}
	if err := m.chainStore.SaveChain(m.storeCtx, ch); err != nil {
		m.log.Warn("chain not persisted", "chain", ch.ID, "err", err)
	}
}

// restoreChains re-arms pumps for every non-terminal chain row the store
// holds. Runs after adopt, so re-adopted children are already registered and
// only discovery's own settling races the pumps. Terminal rows never re-arm
// and their digest window cannot survive a restart, so they delete here.
// Before any pump starts, the rows reconcile against each other: a tail whose
// inbound link landed broken without delivering dies with it, closing the
// crash window between the landing link's row persist and its cascade's.
func (m *Manager) restoreChains(ctx context.Context) {
	if m.chainStore == nil {
		return
	}
	rows, err := m.chainStore.LoadChains(ctx)
	if err != nil {
		m.log.Warn("reading chains failed", "err", err)
		return
	}
	now := time.Now().UnixMilli()
	var rearmed int
	m.mu.Lock()
	byID := make(map[string]*Chain, len(rows))
	for i := range rows {
		byID[rows[i].ID] = &rows[i]
	}
	reconciled := make(map[string]struct{})
	for _, ch := range rows {
		if ch.State != ChainFailed && ch.State != ChainCanceled {
			continue
		}
		m.reconcileChainCascadeLocked(byID, ch.ChildID, ch.State,
			chainUpstreamReason(ch.State, ch.Reason), reconciled, now)
	}
	for _, ch := range rows {
		row := byID[ch.ID]
		if _, ok := reconciled[ch.ID]; ok {
			// the break just landed, its digest window starts now
			run := &chainRun{seq: m.nextChainSeqLocked(), ch: *row}
			m.chains[ch.ID] = run
			continue
		}
		if chainTerminal(row.State) {
			//nolint:contextcheck // row deletion rides the store context
			if err := m.chainStore.DeleteChain(m.storeCtx, ch.ID); err != nil {
				m.log.Warn("chain row not deleted", "chain", ch.ID, "err", err)
			}
			continue
		}
		switch row.State {
		case ChainWaiting, ChainFinal, ChainHandoff, ChainDelivering:
		default:
			continue // unknown states never re-arm a pump
		}
		run := &chainRun{seq: m.nextChainSeqLocked(), ch: *row, restoredAt: now}
		m.chains[ch.ID] = run
		//nolint:contextcheck // pumps ride the manager context, never the caller's
		m.startPumpLocked(m.ctx, run)
		rearmed++
	}
	m.mu.Unlock()
	if rearmed > 0 {
		m.log.Info("chains re-armed after restart", "count", rearmed)
	}
}

// reconcileChainCascadeLocked carries one restored row's broken landing down
// the stored links stacked behind it, flipping each non-terminal tail row onto
// the same terminal state so no pump re-arms over a handoff that never
// landed. Flipped rows register in reconciled, their digest window starts at
// restore instead of never surfacing. mu must be held.
func (m *Manager) reconcileChainCascadeLocked(byID map[string]*Chain, parentID, state, reason string,
	reconciled map[string]struct{}, now int64) {
	for _, row := range byID {
		if chainTerminal(row.State) || row.ParentID != parentID {
			continue
		}
		row.State = state
		row.Reason = reason
		row.UpdatedAt = now
		//nolint:contextcheck // row repair rides the store context
		if err := m.chainStore.SaveChain(m.storeCtx, *row); err != nil {
			m.log.Warn("chain row not repaired", "chain", row.ID, "err", err)
		}
		reconciled[row.ID] = struct{}{}
		m.log.Info("chain broken by its upstream link", "chain", row.ID,
			"parent", row.ParentID, "child", row.ChildID, "reason", reason)
		m.reconcileChainCascadeLocked(byID, row.ChildID, state, reason, reconciled, now)
	}
}

// watchChainRetention prunes terminal chain records and rows past their
// retention: once at start, then on a slow interval.
func (m *Manager) watchChainRetention(ctx context.Context) {
	defer m.wg.Done()
	sweep := func() {
		m.mu.Lock()
		m.pruneChainsLocked()
		m.mu.Unlock()
	}
	sweep()
	t := time.NewTicker(chainSweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			sweep()
		}
	}
}

// chainFolds derives every session's chain facts in one lock hold, names
// resolved on the client so reasons agree across devices. A session can hold
// both roles at once, the application is additive and one field per role
// keeps both links addressable.
type chainFold struct {
	sessionID  string
	inbound    string // parent session id delivering into sessionID
	inboundID  string // that link's chain id
	outbound   string // child session id sessionID feeds
	outboundID string // that link's chain id
	failure    string // fresh failure cause, both endpoints carry it
}

func (m *Manager) chainFolds() []chainFold {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []chainFold
	now := time.Now()
	for _, run := range m.chains {
		ch := run.ch
		switch {
		case chainLive(ch.State):
			out = append(out,
				chainFold{sessionID: ch.ChildID, inbound: ch.ParentID, inboundID: ch.ID},
				chainFold{sessionID: ch.ParentID, outbound: ch.ChildID, outboundID: ch.ID},
			)
		case ch.State == ChainFailed && now.Sub(time.UnixMilli(ch.UpdatedAt)) < chainFailedNotice:
			// both endpoints carry the failure: an exited child keeps no digest
			// row of its own, the parent's row still surfaces the loss
			out = append(out,
				chainFold{sessionID: ch.ChildID, inbound: ch.ParentID,
					inboundID: ch.ID, failure: ch.Reason},
				chainFold{sessionID: ch.ParentID, outbound: ch.ChildID,
					outboundID: ch.ID, failure: ch.Reason})
		}
	}
	return out
}

// foldChainFacts applies one fold onto a digest row. Chain facts are ids and
// one optional failure line, additive beside the row's own kind and reason
// so dialogs and turns keep their copy.
func foldChainFacts(f *digestFacts, fold chainFold) {
	if fold.inbound != "" {
		f.ChainedOn = fold.inbound
		f.ChainedOnID = fold.inboundID
	}
	if fold.outbound != "" {
		f.DeliveringTo = fold.outbound
		f.DeliveringID = fold.outboundID
	}
	f.ChainFailure = fold.failure
}

// startPumpLocked spawns one chain's tick loop. mu must be held.
func (m *Manager) startPumpLocked(ctx context.Context, run *chainRun) {
	run.done = make(chan struct{})
	if ctx == nil || ctx.Err() != nil {
		close(run.done) // a stopping manager never starts a pump
		run.cancel = func() {}
		return
	}
	pctx, cancel := context.WithCancel(ctx)
	run.cancel = cancel
	m.wg.Add(1)
	go m.runChain(pctx, run)
}

// runChain ticks one chain until it lands terminally, its record stays for
// the digest's failure window.
func (m *Manager) runChain(ctx context.Context, run *chainRun) {
	defer m.wg.Done()
	defer close(run.done) // wakes stopPump waiters once the last tick settled
	ticker := time.NewTicker(m.chainPoll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		m.mu.Lock()
		snap := chainSnap{ch: run.ch, refusedAt: run.refusedAt, restoredAt: run.restoredAt}
		m.mu.Unlock()
		if !chainLive(snap.ch.State) {
			return
		}
		if !m.chainStep(ctx, &snap) {
			return
		}
	}
}

// chainSnap is one tick's private view of a chain beside its pump progress.
type chainSnap struct {
	ch         Chain
	refusedAt  int64 // unix ms the last retryable refusal landed
	restoredAt int64 // unix ms the pump re-armed after a restart, 0 live
}

// chainAdopting reports whether a restored chain still owes its endpoints the
// adoption grace: discovery and child re-adoption race startup, so a missing
// session or entry is not yet an exit or an absence.
func (m *Manager) chainAdopting(snap *chainSnap) bool {
	if snap.restoredAt == 0 {
		return false
	}
	return time.Since(time.UnixMilli(snap.restoredAt)) < m.chainGrace
}

// chainRetryPaced reports whether a retryable refusal still paces the next
// submit behind its own fresh window.
func (m *Manager) chainRetryPaced(snap *chainSnap) bool {
	return snap.refusedAt != 0 &&
		time.Since(time.UnixMilli(snap.refusedAt)) < m.parkWindow
}

// chainStep advances one chain a single transition, false answers that the
// chain landed terminally. Every read is off-actor: statuses and entries
// only, so a pump never blocks a mailbox. Gates are session-based: the
// endpoints' own dialogs and turns hold a step, never another session's
// activity or the provider-wide quiet a park flush waits out.
func (m *Manager) chainStep(ctx context.Context, snap *chainSnap) bool {
	switch snap.ch.State {
	case ChainWaiting:
		return m.chainWaiting(ctx, snap)
	case ChainFinal:
		return m.chainFinalWait(ctx, snap)
	case ChainHandoff:
		return m.chainHandoff(ctx, snap)
	case ChainDelivering:
		return m.chainDelivering(ctx, snap)
	}
	return false
}

// chainHeld reports whether one chain endpoint still holds its step: an open
// dialog (a tool barrier included), a live turn, a spinner, queued prompts or
// prompts parked in swarm all mean the session works or waits on its human.
// Queued and parked prompts hold the step so a chain never fires between a
// session's owed turns, and unlike the park queue's quiet-only gate, a chain
// never starts the next session while its predecessor waits for input, so the
// parent always reads as in review before the child begins.
func chainHeld(st *Status) bool {
	return st.OpenInteractions > 0 || st.Running || st.Spinning || st.Queued > 0 || st.Parked > 0
}

// chainInboundHeld reports whether another live chain still delivers into the
// parent, so a chain stacked behind a chained session holds before its own
// gate: a quiet idle parent that has not received its handoff yet is not a
// handoff source, and gating on it alone would fire the link early.
func (m *Manager) chainInboundHeld(parentID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, run := range m.chains {
		if ch := run.ch; chainLive(ch.State) && ch.ChildID == parentID {
			return true
		}
	}
	return false
}

// chainSiblingHeld reports whether another live chain still drives the same
// parent with its own final prompt: one parent runs one chain's turn at a
// time, so two final prompts never interleave and each answer stays
// attributable. The older chain goes first, so two waiting siblings never
// deadlock.
func (m *Manager) chainSiblingHeld(parentID, selfID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	self, ok := m.chains[selfID]
	if !ok {
		return false
	}
	for _, run := range m.chains {
		ch := run.ch
		if ch.ID == selfID || !chainLive(ch.State) || ch.ParentID != parentID {
			continue
		}
		if ch.State == ChainFinal {
			return true // its final turn owns the parent until it settles
		}
		if ch.State == ChainWaiting && ch.FinalPrompt != "" && run.seq < self.seq {
			return true
		}
	}
	return false
}

// liveStatus reads one session's serving row, nil when no live actor holds
// one.
func (m *Manager) liveStatus(sessionID string) *Status {
	a := m.route(sessionID)
	if a == nil {
		return nil
	}
	st := a.status.Load()
	if st == nil || !st.serving() {
		return nil
	}
	return st
}

// sessionProvider names the session's model provider from its live row,
// empty when no serving facts exist yet, which attributes the whole fleet.
func (m *Manager) sessionProvider(sessionID string) string {
	if st := m.liveStatus(sessionID); st != nil {
		return ProviderOf(st.Model)
	}
	return ""
}

// chainInReview reports whether one endpoint sits at a completed-turn review
// point: no work is owed and a turn ended. For a final prompt the turn must
// have ended after that submit was issued, so a stale prior review never
// releases the chain while the final turn is still starting.
func chainInReview(st *Status, since int64) bool {
	return !chainHeld(st) && st.LastTurnEnd > 0 && st.LastTurnEnd >= since
}

// chainBareReview reports whether a bare chain's parent reached review. A
// restored actor loses the live turn-end stamp, so an idle restored parent
// with recorded conversation stands in for that review point.
func (m *Manager) chainBareReview(ctx context.Context, snap *chainSnap, st *Status) bool {
	if st == nil {
		return false
	}
	if chainInReview(st, 0) {
		return true
	}
	if snap.restoredAt == 0 || chainHeld(st) || !st.Idle {
		return false
	}
	entries, _, err := m.Entries(ctx, snap.ch.ParentID, "", chainPageEntries)
	return err == nil && slices.ContainsFunc(entries, func(e ctl.Entry) bool {
		return entryIsUserLine(e) || entryAssistantText(e) != ""
	})
}

// chainWaiting runs the parent gates, then either submits the final prompt,
// or composes the bare child prompt when no final prompt was asked for: only
// a final prompt's answer rides the child's line, never the parent's latest
// response on its own. A bare chain waits for the parent's own review point
// too, and an exited parent never releases one.
func (m *Manager) chainWaiting(ctx context.Context, snap *chainSnap) bool {
	ch := &snap.ch
	if snap.restoredAt != 0 && ch.FinalPrompt != "" {
		// the recorded final submit may already have landed before the restart
		if entry, landed := m.chainFindQueueID(ctx, ch.ParentID, chainFinalPendingID(ch.ID)); landed {
			m.chainBindFinal(snap, entry)
			return true
		}
		if m.chainAdopting(snap) {
			return true // entry facts may still be settling
		}
	}
	if m.chainInboundHeld(ch.ParentID) || m.chainRetryPaced(snap) {
		return true // the gate holds, the next tick re-reads
	}
	st := m.liveStatus(ch.ParentID)
	if st != nil && chainHeld(st) {
		return true
	}
	if ch.FinalPrompt == "" {
		if st == nil {
			if m.chainAdopting(snap) {
				return true // discovery and re-adoption still race startup
			}
			// without a review point the sequence has no predecessor turn, and
			// an exited parent must not hand its past work through
			m.chainFail(snap, "parent exited")
			return false
		}
		if !m.chainBareReview(ctx, snap, st) {
			return true // the parent has not reached a review point yet
		}
		// no response rides along, the child's line is its prompt alone
		m.chainCompose(snap, ch.ChildPrompt)
		return true
	}
	if st == nil {
		if m.chainAdopting(snap) {
			return true // discovery and re-adoption still race startup
		}
		// the final prompt can never run, and without it there is no answer
		m.chainFail(snap, "parent exited")
		return false
	}
	if m.chainSiblingHeld(ch.ParentID, ch.ID) {
		return true // a sibling's final turn owns the parent
	}
	// stamped before the submit: the turn end this submit starts must never
	// read as older than the review point it owes
	at := time.Now().UnixMilli()
	err := m.SubmitTracked(ctx, ch.ParentID, ctl.SubmitParams{
		Line: ch.FinalPrompt, PendingID: chainFinalPendingID(ch.ID),
	})
	if err != nil {
		if chainRetryable(err) {
			m.chainRefused(snap)
			return true // the refusal window paces the retry
		}
		m.chainFail(snap, refusalText(err))
		return false
	}
	// the final turn is provider activity until its facts land, so the other
	// idle gates see it
	m.NoteRelease(m.sessionProvider(ch.ParentID))
	m.chainFinalSubmitted(snap, at)
	return true
}

// chainFinalSubmitted records the final submit's moment and waits out that
// turn's review point. The stamp is the submit's initiation, not its return:
// the actor can process the started turn's own end before the submit call
// returns, and a later stamp would then hold the review point forever.
func (m *Manager) chainFinalSubmitted(snap *chainSnap, at int64) {
	m.mu.Lock()
	if run := m.chains[snap.ch.ID]; run != nil && chainLive(run.ch.State) {
		run.ch.FinalAt = at
		run.ch.State = ChainFinal
		run.ch.UpdatedAt = at
		m.persistChainLocked(run.ch)
	}
	m.mu.Unlock()
	snap.ch.FinalAt = at
	snap.ch.State = ChainFinal
}

// chainFinalReview reports whether the final turn reached its review point.
// A restored actor can lose the live turn-end fact while its transcript still
// proves the final answer landed, so a committed answer after the mark stands
// in for the review event after a restart.
func (m *Manager) chainFinalReview(ctx context.Context, snap *chainSnap, st *Status) bool {
	if st == nil || chainInReview(st, snap.ch.FinalAt) {
		return true
	}
	if snap.restoredAt == 0 {
		return false
	}
	_, ok := m.collectResponse(ctx, snap.ch.ParentID, snap.ch.Mark)
	return ok
}

// chainFinalWait binds the final submit to its committed entry, then waits
// for the parent to finish that turn. Correlation runs by queue id until the
// entry binds, then the persisted mark carries the binding across restarts,
// so a turn that ended while the service was down still rebinds and hands
// off its own answer without re-searching.
func (m *Manager) chainFinalWait(ctx context.Context, snap *chainSnap) bool {
	ch := &snap.ch
	if ch.Mark == "" {
		entry, landed := m.chainFindQueueID(ctx, ch.ParentID, chainFinalPendingID(ch.ID))
		if !landed {
			if m.chainAdopting(snap) {
				return true // entry facts may still be settling
			}
			if m.liveStatus(ch.ParentID) == nil {
				// the submit never landed and can never run now
				m.chainFail(snap, "parent exited")
				return false
			}
			return true // the commit is still in flight
		}
		m.chainBindMark(snap, entry)
		return true
	}
	st := m.liveStatus(ch.ParentID)
	if !m.chainFinalReview(ctx, snap, st) {
		return true // the final turn still owes its answer or its review point
	}
	if st == nil && m.chainAdopting(snap) {
		return true // discovery and re-adoption still race startup
	}
	if st == nil && !m.savedKnown(ch.ParentID) {
		m.chainFail(snap, "parent exited")
		return false
	}
	m.chainSetState(snap, ChainHandoff, "")
	return true
}

// chainHandoff collects the final prompt's answer and composes the child's
// line.
func (m *Manager) chainHandoff(ctx context.Context, snap *chainSnap) bool {
	ch := &snap.ch
	if ch.Mark == "" { // a restored handoff rebinds to its final entry
		entry, landed := m.chainFindQueueID(ctx, ch.ParentID, chainFinalPendingID(ch.ID))
		if !landed {
			if m.chainAdopting(snap) {
				return true
			}
			if m.liveStatus(ch.ParentID) == nil {
				m.chainFail(snap, "parent exited")
				return false
			}
			m.chainSetState(snap, ChainWaiting, "")
			return true // the recorded submit never landed, the prompt runs fresh
		}
		m.chainBindMark(snap, entry)
	}
	if st := m.liveStatus(ch.ParentID); !m.chainFinalReview(ctx, snap, st) {
		return true // a restored turn still owes its review point
	}
	response, ok := m.collectResponse(ctx, ch.ParentID, ch.Mark)
	if !ok {
		// a restored handoff whose turn still runs waits for its answer, a
		// turn that already ended without text failed to earn one
		if st := m.liveStatus(ch.ParentID); st != nil && chainHeld(st) {
			return true
		}
		m.chainFail(snap, "nothing to hand off")
		return false
	}
	m.chainCompose(snap, chainLine(response, ch.ChildPrompt))
	return true
}

// chainDelivering submits the composed line once the child is free of dialogs
// and turns.
func (m *Manager) chainDelivering(ctx context.Context, snap *chainSnap) bool {
	ch := &snap.ch
	a := m.route(ch.ChildID)
	if a == nil {
		if m.chainAdopting(snap) {
			return true
		}
		m.chainFail(snap, "child exited")
		return false
	}
	st := a.status.Load()
	if st == nil {
		return true // no facts yet
	}
	if st.State == ChildExited || st.State == ChildGone {
		m.chainFail(snap, "child exited")
		return false
	}
	if !st.serving() {
		return true // reconnecting
	}
	if chainHeld(st) || m.chainRetryPaced(snap) {
		return true
	}
	m.mu.Lock()
	var composed string
	if run := m.chains[ch.ID]; run != nil {
		composed = run.composed
	}
	m.mu.Unlock()
	if composed == "" {
		// a restored delivery lost its composed line: the child may already
		// hold it, else the line rebuilds from current facts
		if m.chainAdopting(snap) {
			return true
		}
		if _, landed := m.chainFindQueueID(ctx, ch.ChildID, ch.PendingID); landed {
			m.chainSetState(snap, ChainDone, "")
			return false
		}
		if ch.FinalPrompt == "" {
			m.chainCompose(snap, ch.ChildPrompt)
		} else {
			m.chainSetState(snap, ChainHandoff, "")
		}
		return true
	}
	err := m.SubmitTracked(ctx, ch.ChildID, ctl.SubmitParams{Line: composed, PendingID: ch.PendingID})
	if err != nil {
		if chainRetryable(err) {
			m.chainRefused(snap)
			return true // the refusal window paces the retry
		}
		m.chainFail(snap, refusalText(err))
		return false
	}
	// the delivered turn is provider activity until its facts land, so the
	// other idle gates see it
	m.NoteRelease(m.sessionProvider(ch.ChildID))
	m.chainSetState(snap, ChainDone, "")
	m.log.Info("chain delivered", "chain", ch.ID, "parent", ch.ParentID, "child", ch.ChildID)
	return false
}

// chainRetryable reports whether a submit refusal deserves a later tick: a
// missing connection, a seat held against swarm, an observer's write or a
// full queue all clear on their own. Every other refusal fails the chain.
func chainRetryable(err error) bool {
	var ce *ctl.Error
	if errors.As(err, &ce) {
		switch ce.Code {
		case ctl.CodeUnavailable, ctl.CodeSeatHeld, ctl.CodeObserver, ctl.CodeBusy:
			return true
		}
		return false
	}
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}

// refusalText flattens one refusal into the record's reason line.
func refusalText(err error) string {
	if err == nil {
		return ""
	}
	var ce *ctl.Error
	if errors.As(err, &ce) && ce.Message != "" {
		return digestText(ce.Message)
	}
	return digestText(err.Error())
}

// savedKnown reports whether any recorded transcript names the session, the
// handoff's fallback source once the parent leaves discovery.
func (m *Manager) savedKnown(sessionID string) bool {
	_, err := m.savedRow(sessionID)
	return err == nil
}

// chainFindQueueID pages one session's transcript, live and saved, for the
// newest message entry landed under one pending id. Pages walk newest first,
// so the first match within a page scans from its end. Only the unbound
// searches ride this walk, all of them near a restart, so the entries sit
// close to the transcript tail. Both sources are searched so an instance
// leaving mid-walk never turns a landed line into a miss: the live view and
// the recorded transcript hold the same entries.
func (m *Manager) chainFindQueueID(ctx context.Context, sessionID, pendingID string) (ctl.Entry, bool) {
	if entry, ok := m.findQueueIDIn(ctx, sessionID, pendingID, true); ok {
		return entry, true
	}
	return m.findQueueIDIn(ctx, sessionID, pendingID, false)
}

// findQueueIDIn pages one source: the live actor's retained entries when live,
// the recorded transcript otherwise.
func (m *Manager) findQueueIDIn(ctx context.Context, sessionID, pendingID string, live bool) (ctl.Entry, bool) {
	before := ""
	for range chainCollectPages {
		var entries []ctl.Entry
		var cursor string
		if live {
			var err error
			entries, cursor, err = m.Entries(ctx, sessionID, before, chainPageEntries)
			if err != nil {
				return ctl.Entry{}, false
			}
		} else {
			page, err := m.SavedEntries(sessionID, before, chainPageEntries)
			if err != nil {
				return ctl.Entry{}, false
			}
			entries, cursor = page.Entries, page.Cursor
		}
		for i := len(entries) - 1; i >= 0; i-- {
			if entryHasQueueID(entries[i], pendingID) {
				return entries[i], true
			}
		}
		if cursor == "" || len(entries) == 0 {
			break
		}
		before = cursor
	}
	return ctl.Entry{}, false
}

// entryHasQueueID reports whether one entry's message landed under pendingID.
func entryHasQueueID(e ctl.Entry, pendingID string) bool {
	if e.Type != string(session.TypeMessage) || len(e.Data) == 0 {
		return false
	}
	var md session.MessageData
	if json.Unmarshal(e.Data, &md) != nil {
		return false
	}
	return slices.Contains(md.QueueIDs, pendingID)
}

// entryIsUserLine reports whether one entry is a committed human prompt.
func entryIsUserLine(e ctl.Entry) bool {
	if e.Type != string(session.TypeMessage) || len(e.Data) == 0 {
		return false
	}
	var md session.MessageData
	return json.Unmarshal(e.Data, &md) == nil && md.Message.Role == llm.RoleUser
}

// entryAssistantText returns one entry's assistant text, empty when the
// entry is not an assistant message or carries no text.
func entryAssistantText(e ctl.Entry) string {
	if e.Type != string(session.TypeMessage) || len(e.Data) == 0 {
		return ""
	}
	var md session.MessageData
	if json.Unmarshal(e.Data, &md) != nil || md.Message.Role != llm.RoleAssistant {
		return ""
	}
	return strings.TrimSpace(llm.JoinText(md.Message.Content))
}

// collectResponse finds the parent's answer to its final prompt: the newest
// assistant text above the prompt's own entry that no later human line owns,
// so a conversation the human continued after the chain's line never steals
// the handoff. The walk stops at the mark entry itself, no id-order assumed,
// and an unreached mark answers false: entries above the retained window
// cannot prove which answer the chain owes.
func (m *Manager) collectResponse(ctx context.Context, parentID, mark string) (string, bool) {
	if text, ok := m.collectResponseIn(ctx, parentID, mark, true); ok {
		return text, true
	}
	return m.collectResponseIn(ctx, parentID, mark, false)
}

// collectResponseIn walks one source: the live actor's retained entries when
// live, the recorded transcript otherwise.
func (m *Manager) collectResponseIn(ctx context.Context, parentID, mark string, live bool) (string, bool) {
	before := ""
	answer := ""
	for range chainCollectPages {
		var entries []ctl.Entry
		var cursor string
		if live {
			var err error
			entries, cursor, err = m.Entries(ctx, parentID, before, chainPageEntries)
			if err != nil {
				return "", false
			}
		} else {
			page, err := m.SavedEntries(parentID, before, chainPageEntries)
			if err != nil {
				return "", false
			}
			entries, cursor = page.Entries, page.Cursor
		}
		for i := len(entries) - 1; i >= 0; i-- {
			e := entries[i]
			if e.ID == mark {
				return answer, answer != "" // the prompt's own entry bounds the walk
			}
			if entryIsUserLine(e) {
				answer = "" // a later human line owns the entries above it
				continue
			}
			if answer == "" {
				answer = entryAssistantText(e)
			}
		}
		if cursor == "" || len(entries) == 0 {
			break // the mark predates the retained window
		}
		before = cursor
	}
	return "", false // an unreached mark never owns the entries above it
}

// chainLine composes the child's one submit line behind a final prompt: the
// prompt's answer rides under a plain "last message" header, the child prompt
// follows the rule separator.
func chainLine(response, childPrompt string) string {
	runes := []rune(response)
	if len(runes) > maxComposedRunes {
		response = string(runes[len(runes)-maxComposedRunes:])
	}
	return chainLineHeader + "\n" + response + chainLineSep + childPrompt
}

// chainCompose records the child's line and moves the chain to delivering.
func (m *Manager) chainCompose(snap *chainSnap, composed string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if run := m.chains[snap.ch.ID]; run != nil && chainLive(run.ch.State) {
		run.composed = composed
		run.ch.State = ChainDelivering
		run.ch.UpdatedAt = time.Now().UnixMilli()
		m.persistChainLocked(run.ch)
		snap.ch.State = ChainDelivering
	}
}

// chainBindFinal re-arms a chain onto its already-landed final submit: the
// entry bounds collection, the state waits out that turn. The mark persists
// with the state so a later restart rebinds without re-searching.
func (m *Manager) chainBindFinal(snap *chainSnap, entry ctl.Entry) {
	m.mu.Lock()
	if run := m.chains[snap.ch.ID]; run != nil && chainLive(run.ch.State) {
		run.ch.Mark = entry.ID
		run.ch.State = ChainFinal
		if run.ch.FinalAt == 0 {
			// the submit predates the restart, but never the chain itself
			run.ch.FinalAt = run.ch.CreatedAt
		}
		run.ch.UpdatedAt = time.Now().UnixMilli()
		m.persistChainLocked(run.ch)
	}
	m.mu.Unlock()
	snap.ch.Mark = entry.ID
	snap.ch.State = ChainFinal
	if snap.ch.FinalAt == 0 {
		snap.ch.FinalAt = snap.ch.CreatedAt
	}
}

// chainBindMark binds a live chain's collection mark to its final submit's
// committed entry and persists it, so collection survives a restart.
func (m *Manager) chainBindMark(snap *chainSnap, entry ctl.Entry) {
	m.mu.Lock()
	if run := m.chains[snap.ch.ID]; run != nil {
		run.ch.Mark = entry.ID
		m.persistChainLocked(run.ch)
	}
	m.mu.Unlock()
	snap.ch.Mark = entry.ID
}

// chainRefused records one retryable refusal, pacing the retry behind the
// quiet gate.
func (m *Manager) chainRefused(snap *chainSnap) {
	at := time.Now().UnixMilli()
	m.mu.Lock()
	if run := m.chains[snap.ch.ID]; run != nil {
		run.refusedAt = at
	}
	m.mu.Unlock()
	snap.refusedAt = at
}

// chainSetState moves one live chain onto its next state. A landing that
// breaks the sequence (failed or canceled, never done) cascades to the links
// stacked behind it.
func (m *Manager) chainSetState(snap *chainSnap, state, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	run := m.chains[snap.ch.ID]
	if run == nil || !chainLive(run.ch.State) {
		return
	}
	if chainTerminal(state) {
		m.landChainLocked(run, state, reason)
	} else {
		run.ch.State = state
		run.ch.Reason = reason
		run.ch.UpdatedAt = time.Now().UnixMilli()
		m.persistChainLocked(run.ch)
	}
	snap.ch.State = state
	snap.ch.Reason = reason
}

// landChainLocked moves one live chain onto a terminal state and persists it.
// A link that dies without delivering breaks the sequence behind it, so the
// landing cascades: the child session never receives its handoff, and a link
// reading that session as its parent must not fire on its idle state. A
// downstream pump one tick into its submit may still land one orphaned final
// prompt, the landing itself can never be un-delivered. mu must be held.
func (m *Manager) landChainLocked(run *chainRun, state, reason string) {
	if !chainLive(run.ch.State) {
		return
	}
	run.ch.State = state
	run.ch.Reason = reason
	run.ch.UpdatedAt = time.Now().UnixMilli()
	m.persistChainLocked(run.ch)
	if state == ChainFailed {
		m.log.Warn("chain failed", "chain", run.ch.ID, "parent", run.ch.ParentID,
			"child", run.ch.ChildID, "reason", reason)
	}
	if state == ChainFailed || state == ChainCanceled {
		m.cascadeChainsLocked(run.ch.ChildID, state, chainUpstreamReason(state, reason))
	}
}

// cascadeChainsLocked terminates every live chain stacked behind one landing
// link. Failures carry their cause forward, a canceled upstream lands its tail
// canceled. Each flipped link is terminal before the recursion descends, so
// every record is visited at most once. mu must be held.
func (m *Manager) cascadeChainsLocked(parentID, state, reason string) {
	for _, run := range m.chains {
		if !chainLive(run.ch.State) || run.ch.ParentID != parentID {
			continue
		}
		run.ch.State = state
		run.ch.Reason = reason
		run.ch.UpdatedAt = time.Now().UnixMilli()
		m.persistChainLocked(run.ch)
		m.log.Info("chain broken by its upstream link", "chain", run.ch.ID,
			"parent", run.ch.ParentID, "child", run.ch.ChildID, "reason", reason)
		m.cascadeChainsLocked(run.ch.ChildID, state, reason)
	}
}

// chainUpstreamReason names why a stacked link died: the landing link's own
// cause, prefixed so the digest line reads from the tail's seat.
func chainUpstreamReason(state, reason string) string {
	if reason != "" {
		return "upstream " + reason
	}
	return "upstream " + state
}

// chainFail terminates one chain with its cause.
func (m *Manager) chainFail(snap *chainSnap, reason string) {
	m.chainSetState(snap, ChainFailed, reason)
}
