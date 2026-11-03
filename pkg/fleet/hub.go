package fleet

import (
	"strings"
	"sync"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/ctl"
)

const (
	// subQueue frames buffer behind one subscription before its reader counts
	// as slow. Overflow drops the whole connection, mirroring upstream's
	// fail-open rule: a stalled viewer loses its socket, never the session.
	subQueue = 256

	// coalesceWindow batches ephemeral stream deltas server-side. Committed
	// events always flush what is staged and pass through verbatim.
	coalesceWindow = 30 * time.Millisecond
)

// subscription is one viewer's seat on one session: a bounded queue drained by
// its own forwarder, with ephemeral deltas coalesced behind the window so a
// streaming turn costs one frame per batch instead of hundreds. mu guards the
// publish side; hostKey lives under the manager lock.
type subscription struct {
	id        int64
	sessionID string
	hostKey   actorKey // the actor currently serving this subscription

	q         chan []byte
	closed    chan struct{} // closed when unsubscribed or dropped
	closeOnce sync.Once

	deliver func([]byte) // blocks until the connection accepts or dies
	onDrop  func()       // fires once when the queue overflows

	mu      sync.Mutex
	pending *stagedDelta
	dropped bool
	retired bool // replaced by its session's next instance; never greet again
}

// stagedDelta is one coalescing message not yet enqueued: consecutive deltas
// for the same stream merge, carrying the highest seq seen.
type stagedDelta struct {
	key   string // the coalesce identity this message merges under
	name  string // text.delta, thinking.delta or tool.output
	id    string // tool call id when keyed, else empty
	delta strings.Builder
	seq   uint64
}

// newStaged stages one delta under a key coalesceKey already computed.
func newStaged(key string, ev ctl.Event) *stagedDelta {
	s := &stagedDelta{key: key, name: ev.Name, seq: ev.Seq}
	if s.name == ctl.EventToolOutput {
		var d ctl.ToolOutputData
		if err := ev.Decode(&d); err == nil { // decode holds per coalesceKey
			s.id = d.ID
			s.delta.WriteString(d.Delta)
		}
		return s
	}
	var first ctl.TextData // text.delta and thinking.delta share the field
	if err := ev.Decode(&first); err == nil {
		s.delta.WriteString(first.Delta)
	}
	return s
}

func (s *stagedDelta) merge(ev ctl.Event) {
	var d ctl.TextData // text.delta and tool.output share the delta field name
	if err := ev.Decode(&d); err != nil {
		return
	}
	s.delta.WriteString(d.Delta)
	if ev.Seq > s.seq {
		s.seq = ev.Seq
	}
}

// frame rebuilds one verbatim-shaped event from what merged.
func (s *stagedDelta) frame(sessionID string) []byte {
	var data any
	switch s.name {
	case ctl.EventToolOutput:
		data = ctl.ToolOutputData{ID: s.id, Delta: s.delta.String()}
	default:
		data = ctl.TextData{Delta: s.delta.String()}
	}
	return marshalEventFrame(sessionID, ctl.NewEvent(s.name, s.seq, data))
}

// coalesceKey names the stream a delta belongs to, so two tool calls never
// merge into one. ok is false for every non-delta event.
func coalesceKey(ev ctl.Event) (key string, ok bool) {
	switch ev.Name {
	case ctl.EventTextDelta, ctl.EventThinkingDelta:
		return ev.Name + "\x00", true
	case ctl.EventToolOutput:
		var d ctl.ToolOutputData
		if err := ev.Decode(&d); err != nil || d.ID == "" {
			return "", false
		}
		return ev.Name + "\x00" + d.ID, true
	default:
		return "", false
	}
}

// greet enqueues the subscribe answer for a fresh attachment, plus a lifecycle
// frame when the instance is degraded, unless the subscription was already
// retired by its instance's replacement. It reports whether the queue
// overflowed.
func (s *subscription) greet(init []byte, child *ChildFrame) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.retired {
		return false
	}
	fire := s.publishFrameLocked(init)
	if !fire && child != nil {
		fire = s.publishFrameLocked(mustJSON(*child))
	}
	return fire
}

// retire marks the subscription as replaced and queues its retirement notice,
// reporting whether the queue overflowed.
func (s *subscription) retire() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.retired {
		return false
	}
	s.retired = true
	return s.sendLocked(mustJSON(ChildFrame{
		Type: FrameChild, SessionID: s.sessionID, State: ChildGone,
	}))
}

// rehost clears the retirement marker so the subscription can greet the next
// instance serving its session.
func (s *subscription) rehost() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.retired = false
}

// publish offers one upstream event: mergeable deltas join the staged message,
// anything else flushes first so per-subscriber order matches seq order.
func (s *subscription) publish(ev ctl.Event, frame []byte) {
	key, ok := coalesceKey(ev)
	s.mu.Lock()
	fire := s.publishLocked(key, ok, ev, frame)
	s.mu.Unlock()
	if fire {
		s.fireDrop()
	}
}

func (s *subscription) publishLocked(key string, ok bool, ev ctl.Event, frame []byte) bool {
	if s.dropped {
		return false
	}
	if ok && s.pending != nil && s.pending.key == key {
		s.pending.merge(ev)
		return false
	}
	if s.pending != nil {
		if s.flushLocked() {
			return true // the flush filled a full queue; stop here
		}
	}
	if ok {
		s.pending = newStaged(key, ev)
		time.AfterFunc(coalesceWindow, s.flushTick)
		return false
	}
	return s.sendLocked(frame)
}

// publishFrame enqueues a synthesized frame (init, child), flushing any staged
// delta ahead of it to preserve order.
func (s *subscription) publishFrame(frame []byte) {
	s.mu.Lock()
	fire := s.publishFrameLocked(frame)
	s.mu.Unlock()
	if fire {
		s.fireDrop()
	}
}

func (s *subscription) publishFrameLocked(frame []byte) bool {
	if s.dropped {
		return false
	}
	if s.pending != nil {
		if s.flushLocked() {
			return true
		}
	}
	return s.sendLocked(frame)
}

// flushTick bounds staged-delta latency when the stream goes quiet.
func (s *subscription) flushTick() {
	s.mu.Lock()
	fire := false
	if !s.dropped && s.pending != nil {
		fire = s.flushLocked()
	}
	s.mu.Unlock()
	if fire {
		s.fireDrop()
	}
}

// flushLocked encodes the staged delta and enqueues it, reporting whether the
// queue overflowed. mu must be held.
func (s *subscription) flushLocked() bool {
	frame := s.pending.frame(s.sessionID)
	s.pending = nil
	return s.sendLocked(frame)
}

// sendLocked enqueues without ever blocking the actor; overflow drops and
// reports it, so the caller fires onDrop outside the lock.
func (s *subscription) sendLocked(frame []byte) bool {
	select {
	case s.q <- frame:
		return false
	default:
		if !s.dropped {
			s.dropped = true
			return true
		}
		return false
	}
}

// fireDrop signals the connection once: a slow reader loses its socket. It is
// always called outside mu, so callbacks may re-enter subscription methods.
func (s *subscription) fireDrop() {
	if s.onDrop != nil {
		s.onDrop()
	}
}

// close ends the subscription after an unsubscribe or teardown. Queued frames
// are abandoned; clients reconcile from their next init.
func (s *subscription) close() {
	s.mu.Lock()
	s.dropped = true
	s.mu.Unlock()
	s.closeOnce.Do(func() { close(s.closed) })
}

// forward drains the queue into the connection until it closes or drops.
func (s *subscription) forward() {
	for {
		select {
		case <-s.closed:
			return
		case frame := <-s.q:
			s.deliver(frame)
		}
	}
}

// hub tracks one actor's subscribers. The map itself takes a lock because
// stop() fans out from the manager goroutine; everything else still sequences
// through the actor mailbox, so per-subscriber order matches event order.
type hub struct {
	mu   sync.Mutex
	subs map[int64]*subscription
}

func newHub() *hub { return &hub{subs: make(map[int64]*subscription)} }

// attach registers a subscriber under the id its manager already assigned;
// one id namespace keeps detach and rebind lookups stable.
func (h *hub) attach(sub *subscription) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[sub.id] = sub
}

func (h *hub) detach(sub *subscription) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, sub.id)
}

// has reports whether an id is currently subscribed.
func (h *hub) has(id int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.subs[id]
	return ok
}

// snapshot copies the subscriber list for fanout outside the lock.
func (h *hub) snapshot() []*subscription {
	h.mu.Lock()
	defer h.mu.Unlock()
	return bulk.MapValuesSlice(h.subs)
}

// publishEvent fans one upstream event out to every subscriber.
func (h *hub) publishEvent(sessionID string, ev ctl.Event) {
	frame := marshalEventFrame(sessionID, ev)
	if frame == nil { // a required payload failed to encode; drop rather than corrupt
		return
	}
	for _, sub := range h.snapshot() {
		sub.publish(ev, frame)
	}
}

// publishChild fans one lifecycle frame out verbatim, no coalescing.
func (h *hub) publishChild(frame ChildFrame) {
	for _, sub := range h.snapshot() {
		sub.publishFrame(mustJSON(frame))
	}
}

// marshalEventFrame encodes one event frame; a payload that cannot encode is
// dropped rather than corrupting the stream, matching upstream's rule.
func marshalEventFrame(sessionID string, ev ctl.Event) []byte {
	if len(ev.Data) == 0 && needsData(ev.Name) {
		return nil
	}
	return mustJSON(EventFrame{Type: FrameEvent, SessionID: sessionID, Event: ev})
}

// needsData lists event families whose payloads are never optional on the wire.
func needsData(name string) bool {
	switch name {
	case ctl.EventEntryAppend, ctl.EventBranchChanged, ctl.EventStatus,
		ctl.EventActivity, ctl.EventQueued, ctl.EventQueueDropped,
		ctl.EventPermission, ctl.EventTools, ctl.EventIdle,
		ctl.EventInteractionPending, ctl.EventInteractionSettled:
		return true
	default:
		return false
	}
}
