// Package fleettest provides a stub ajent control-socket server for tests
// that exercise fleet consumers: hello, snapshots, backfill through a real
// transcript file, seat semantics and scripted event fanout.
package fleettest

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/paths"
	"github.com/jentfoo/ajent/pkg/session"
)

// Entry is the transcript-entry shape writers hand to WriteTranscript; a thin
// alias so tests need no second import.
type Entry = session.Entry

// stubWorkspace is where every stub claims to run.
const stubWorkspace = "/repo"

// Options configures one stub at creation.
type Options struct {
	SessionID string
	Name      string
	Token     string // writer token; a fixed default when empty
	PID       int    // hello pid override; this process when zero
	Refuses   bool   // attach with control always refuses, seat-held
}

// RecordedRequest is one request the stub received beside its raw params.
type RecordedRequest struct {
	Method string
	Params json.RawMessage
}

// Stub is a minimal ajent serving session bound under <home>/control.
type Stub struct {
	ln        net.Listener
	home      string
	sessionID string
	name      string
	token     string
	protocol  int
	pid       int

	mu       sync.Mutex
	seq      uint64 // one number space per session lifetime
	snap     ctl.State
	recordTo string // transcript file hello and backfill name
	heldBy   string // holder name while the seat is claimed, "" otherwise
	heldConn *stubConn
	refuse   bool
	conns    map[*stubConn]struct{}
	dials    int // served hellos, so tests count dials

	refuseScript map[string]*ctl.Error  // scripted per-method refusals
	resultScript map[string]any         // scripted success payloads
	onSubmit     func(ctl.SubmitParams) // fires after a submit request is recorded
	requests     []RecordedRequest
}

// New binds a stub's socket under home and starts accepting. Callers still
// write the registry record when they want discovery to see it.
func New(t *testing.T, home string, opts Options) *Stub {
	t.Helper()
	if opts.SessionID == "" {
		opts.SessionID = "01STUBSESSION00000000"
	}
	if opts.Token == "" {
		opts.Token = "token1234"
	}
	recordTo := filepath.Join(home, "transcript.jsonl") // serve mode always records
	if err := os.WriteFile(recordTo, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, paths.ControlDirName, opts.SessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", filepath.Join(dir, opts.Token+".sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	pid := opts.PID
	if pid == 0 {
		pid = os.Getpid()
	}
	f := &Stub{
		pid:          pid,
		ln:           ln,
		home:         home,
		sessionID:    opts.SessionID,
		name:         opts.Name,
		token:        opts.Token,
		protocol:     ctl.Protocol,
		recordTo:     recordTo,
		conns:        make(map[*stubConn]struct{}),
		refuse:       opts.Refuses,
		refuseScript: make(map[string]*ctl.Error),
		resultScript: make(map[string]any),
	}
	f.snap.Session.ID = f.sessionID
	f.snap.Session.Name = opts.Name
	f.snap.Workspace = stubWorkspace
	f.snap.Cwd = "/repo"

	go f.acceptLoop()
	return f
}

// WriteRegistry publishes the discovery record; pid must answer signal zero.
func (f *Stub) WriteRegistry(t *testing.T, pid int, startedAt time.Time) {
	t.Helper()
	b, err := json.Marshal(ctl.Instance{
		SessionID:   f.sessionID,
		SessionName: f.name,
		Workspace:   f.snap.Workspace,
		StartedAt:   startedAt.UnixMilli(),
		PID:         pid,
		Token:       f.token,
		Socket:      f.Path(),
	})
	if err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(f.home, paths.ControlDirName, f.sessionID, f.token+".json")
	if err := os.WriteFile(record, b, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(record) })
}

// RemoveRegistry retracts the discovery record, like a torn-down instance.
func (f *Stub) RemoveRegistry() {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = os.Remove(filepath.Join(f.home, paths.ControlDirName, f.sessionID, f.token+".json"))
}

// SetSnapshot configures what state.get answers, head included.
func (f *Stub) SetSnapshot(snap ctl.State) {
	f.mu.Lock()
	defer f.mu.Unlock()
	snap.Session.ID = f.sessionID
	snap.Session.Name = f.name
	f.snap = snap
}

// WriteTranscript records entries to the stub's file and moves the head there.
func (f *Stub) WriteTranscript(t *testing.T, entries ...Entry) {
	t.Helper()
	path := filepath.Join(f.home, "transcript.jsonl")
	var buf []byte
	for _, e := range entries {
		line, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		buf = append(buf, line...)
		buf = append(buf, '\n')
	}
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		t.Fatal(err)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	f.recordTo = path
	if len(entries) > 0 { // the head is the newest entry on the branch
		f.snap.Head = entries[len(entries)-1].ID
	}
}

// Broadcast stamps one event and writes it to every live connection.
func (f *Stub) Broadcast(name string, data any) ctl.Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	ev := ctl.NewEvent(name, f.seq, data)
	for c := range f.conns {
		_ = c.enc.Encode(ev)
	}
	return ev
}

// DropConns severs every open connection without an exit event.
func (f *Stub) DropConns() {
	f.mu.Lock()
	conns := bulk.MapKeysSlice(f.conns)
	f.mu.Unlock()
	for _, c := range conns {
		_ = c.conn.Close()
	}
}

// Exit broadcasts session.exit and closes everything, like a served run ending.
func (f *Stub) Exit(reason string) {
	f.Broadcast(ctl.EventSessionExit, ctl.SessionExitData{Reason: reason})
	f.DropConns()
}

// DialCount reports how many hellos the stub has served.
func (f *Stub) DialCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dials
}

// SeatHolder names the current seat holder, empty when none.
func (f *Stub) SeatHolder() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.heldBy
}

// SessionID names the session every connection of this stub serves.
func (f *Stub) SessionID() string { return f.sessionID }

// Path reports the socket path this stub listens on.
func (f *Stub) Path() string { return f.ln.Addr().String() }

// Refuse scripts one method to always answer this coded refusal, before any
// seat check, so consumers can test their error mapping per code.
func (f *Stub) Refuse(method, code, message string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refuseScript[method] = &ctl.Error{Code: code, Message: message}
}

// Result scripts one method's success payload; the default reply is empty.
func (f *Stub) Result(method string, result any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resultScript[method] = result
}

// OnSubmit registers fn to run whenever the stub serves a submit request;
// the params are already recorded when it fires. Safe to call mid-flight.
func (f *Stub) OnSubmit(fn func(ctl.SubmitParams)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onSubmit = fn
}

// Received returns every request the stub has served, oldest first.
func (f *Stub) Received() []RecordedRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.requests)
}

func (f *Stub) acceptLoop() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.serveConn(conn)
	}
}

// stubConn is one controller connection the stub serves.
type stubConn struct {
	s    *Stub
	conn net.Conn
	enc  *ctl.Encoder
}

func (f *Stub) serveConn(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	c := &stubConn{s: f, conn: conn, enc: ctl.NewEncoder(conn)}

	f.mu.Lock()
	f.seq++
	helloSeq := f.seq
	f.dials++
	f.conns[c] = struct{}{}
	transcript := f.recordTo
	f.mu.Unlock()

	err := c.enc.Encode(ctl.NewEvent(ctl.EventHello, helloSeq, ctl.Hello{
		Protocol:       f.protocol,
		Session:        ctl.Session{ID: f.sessionID},
		Workspace:      stubWorkspace,
		Cwd:            "/repo",
		Serve:          true,
		PID:            f.pid,
		TranscriptPath: transcript,
		Token:          f.token,
	}))
	if err != nil {
		return
	}

	dec := ctl.NewDecoder(conn)
	for {
		var req ctl.Request
		if err := dec.Decode(&req); err != nil {
			f.mu.Lock()
			delete(f.conns, c)
			if f.heldConn == c { // EOF releases the seat immediately
				f.heldBy = ""
				f.heldConn = nil
			}
			f.mu.Unlock()
			return
		}
		if !c.handle(req) {
			return
		}
	}
}

// handle answers one request; false closes the connection.
func (c *stubConn) handle(req ctl.Request) bool {
	if rp, ok := c.s.scripted(req); ok {
		return c.reply(rp)
	}
	switch req.Method {
	case ctl.MethodState:
		c.s.mu.Lock()
		snap := c.s.snap
		c.s.seq++
		seq := c.s.seq
		c.s.mu.Unlock()
		return c.reply(ctl.Reply{ID: req.ID, Seq: seq, Result: ctl.EncodeData(snap)})

	case ctl.MethodAttach:
		var p ctl.AttachParams
		_ = json.Unmarshal(req.Params, &p)
		if !c.attach(p) {
			c.s.mu.Lock()
			seq := c.s.seq
			holder := c.s.heldBy
			c.s.mu.Unlock()
			return c.reply(ctl.Reply{ID: req.ID, Seq: seq,
				Error: ctl.Errf(ctl.CodeSeatHeld, "seat held by %s", holder)})
		}
		return c.reply(ctl.Reply{ID: req.ID,
			Result: ctl.EncodeData(ctl.AttachResult{Control: true})})

	case ctl.MethodSubmit:
		if !c.requireSeat(req) {
			return true
		}
		var p ctl.SubmitParams
		_ = json.Unmarshal(req.Params, &p)
		c.s.mu.Lock()
		seq := c.s.seq
		c.s.mu.Unlock()
		return c.reply(ctl.Reply{ID: req.ID, Seq: seq})

	case ctl.MethodInterrupt, ctl.MethodModeCycle,
		ctl.MethodQueueRecall, ctl.MethodRewind,
		ctl.MethodResolve:
		if !c.requireSeat(req) {
			return true
		}
		c.s.mu.Lock()
		seq := c.s.seq
		c.s.mu.Unlock()
		return c.reply(ctl.Reply{ID: req.ID, Seq: seq})

	default:
		return c.reply(ctl.Reply{ID: req.ID,
			Error: ctl.Errf(ctl.CodeUnknownMethod, "unknown method %q", req.Method)})
	}
}

// requireSeat answers an observer refusal when this connection holds no seat.
func (c *stubConn) requireSeat(req ctl.Request) bool {
	c.s.mu.Lock()
	held := c.s.heldConn == c
	seq := c.s.seq
	c.s.mu.Unlock()
	if held {
		return true
	}
	c.reply(ctl.Reply{ID: req.ID, Seq: seq,
		Error: ctl.Errf(ctl.CodeObserver, "observers cannot write")})
	return false
}

// scripted answers a request whose reply the test fixed, recording it first.
func (f *Stub) scripted(req ctl.Request) (ctl.Reply, bool) {
	var hookSubmit ctl.SubmitParams
	f.mu.Lock()
	f.requests = append(f.requests, RecordedRequest{Method: req.Method, Params: req.Params})
	hook := f.onSubmit
	if hook != nil && req.Method == ctl.MethodSubmit {
		_ = json.Unmarshal(req.Params, &hookSubmit)
	}
	var reply ctl.Reply
	if err, ok := f.refuseScript[req.Method]; ok {
		reply.Error = err
	} else if res, ok := f.resultScript[req.Method]; ok {
		reply.Result = ctl.EncodeData(res)
	} else {
		f.mu.Unlock()
		if hook != nil && req.Method == ctl.MethodSubmit {
			hook(hookSubmit)
		}
		return ctl.Reply{}, false
	}
	reply.ID, reply.Seq = req.ID, f.seq
	f.mu.Unlock()
	if hook != nil && req.Method == ctl.MethodSubmit {
		hook(hookSubmit)
	}
	return reply, true
}

// attach applies the seat rules; false refuses with seat-held.
func (c *stubConn) attach(p ctl.AttachParams) bool {
	f := c.s
	f.mu.Lock()
	defer f.mu.Unlock()

	if p.Control && f.refuse {
		return false // scripted: even a forced claim is refused
	}
	if !p.Control {
		return true // observer attach always succeeds
	}
	if f.heldConn == nil || f.heldConn == c {
		f.heldBy = p.Holder
		f.heldConn = c
		return true
	}
	if !p.Force {
		return false
	}
	from := f.heldBy // forced takeover announces itself to every connection
	if from == "" {
		from = "controller"
	}
	f.heldBy = p.Holder
	f.heldConn = c
	f.seq++
	ev := ctl.NewEvent(ctl.EventSeatLost, f.seq, ctl.SeatLostData{From: from, To: p.Holder})
	for other := range f.conns {
		_ = other.enc.Encode(ev)
	}
	return true
}

func (c *stubConn) reply(rp ctl.Reply) bool {
	return c.enc.Encode(rp) == nil
}
