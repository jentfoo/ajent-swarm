package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/go-analyze/bulk"
	"github.com/gorilla/websocket"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
)

// Stream timings. Pings keep half-open sockets surfacing quickly: browsers
// pong automatically, and any inbound frame refreshes the read deadline.
const (
	wsWriteWait      = 10 * time.Second
	hbPongWait       = 60 * time.Second
	defaultPingEvery = 20 * time.Second
	wsReadLimit      = 16 << 10 // client frames carry ids, never content
	sendQueueSize    = 256
)

// hbPingEvery is a var so tests can shorten the liveness cadence.
var hbPingEvery = defaultPingEvery

// upgrader admits same-origin handshakes only. Auth ran in the middleware,
// and session cookies are SameSite=Lax, so a cross-origin browser page can
// neither read nor attach.
var upgrader = websocket.Upgrader{CheckOrigin: sameOrigin}

func sameOrigin(r *http.Request) bool {
	raw := r.Header.Get("Origin")
	if raw == "" { // non-browser clients authenticate with bearer tokens
		return true
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return u.Host == r.Host
}

// streamConn is one browser's multiplexed connection: a single send queue all
// of its subscriptions feed, one write pump, one read loop.
type streamConn struct {
	srv  *apiServer
	ws   *websocket.Conn
	send chan []byte
	done chan struct{}
	once sync.Once

	mu   sync.Mutex
	subs map[string]*fleet.Subscription
}

// handleStream upgrades and serves /api/stream until either side drops.
func (s *apiServer) handleStream(w http.ResponseWriter, r *http.Request) {
	wsc, err := upgrader.Upgrade(w, r, nil)
	if err != nil { // the upgrade already answered
		return
	}
	sc := &streamConn{
		srv:  s,
		ws:   wsc,
		send: make(chan []byte, sendQueueSize),
		done: make(chan struct{}),
		subs: make(map[string]*fleet.Subscription),
	}
	go sc.writePump()
	sc.readPump()
}

// fail tears the connection down once; every blocked path unwinds through it.
func (sc *streamConn) fail() {
	sc.once.Do(func() {
		close(sc.done)
		_ = sc.ws.Close()
	})
}

// deliver blocks until the write pump accepts a frame or the conn dies. It
// runs on each subscription's forwarder, so one stalled session never delays
// another.
func (sc *streamConn) deliver(frame []byte) {
	select {
	case sc.send <- frame:
	case <-sc.done:
	}
}

// readPump consumes client frames until the socket drops, then unsubscribes.
func (sc *streamConn) readPump() {
	defer sc.teardown()
	sc.ws.SetReadLimit(wsReadLimit)
	_ = sc.ws.SetReadDeadline(time.Now().Add(hbPongWait))
	sc.ws.SetPongHandler(func(string) error {
		return sc.ws.SetReadDeadline(time.Now().Add(hbPongWait))
	})

	for {
		_, raw, err := sc.ws.ReadMessage()
		if err != nil {
			return
		}
		_ = sc.ws.SetReadDeadline(time.Now().Add(hbPongWait))

		var f fleet.ClientFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			sc.pushError("bad_request", "frame is not valid JSON", "")
			continue
		}
		switch f.Type {
		case fleet.FrameSubscribe:
			sc.subscribe(&f)
		case fleet.FrameUnsubscribe:
			sc.unsubscribe(f.SessionID)
		case fleet.FrameSync:
			sc.sync(&f)
		default:
			sc.pushError("bad_request", "unknown frame type "+f.Type, f.SessionID)
		}
	}
}

// subscribe registers the connection on one session's stream. A repeat
// subscribe re-syncs instead of stacking a second seat on the same pane.
func (sc *streamConn) subscribe(f *fleet.ClientFrame) {
	if f.SessionID == "" {
		sc.pushError("bad_request", "subscribe needs a sessionId", "")
		return
	}
	sc.mu.Lock()
	if _, tracked := sc.subs[f.SessionID]; tracked {
		sc.mu.Unlock()
		sc.sync(f)
		return
	}

	sub, err := sc.srv.fleet.Subscribe(f.SessionID, sc.deliver, sc.fail)
	if err != nil {
		sc.mu.Unlock()
		code := "unknown_session"
		if !errors.Is(err, fleet.ErrUnknownSession) {
			code = "subscribe_failed"
		}
		sc.pushError(code, "", f.SessionID)
		return
	}
	sc.subs[f.SessionID] = sub
	sc.mu.Unlock()
}

func (sc *streamConn) unsubscribe(sessionID string) {
	if sessionID == "" {
		sc.pushError("bad_request", "unsubscribe needs a sessionId", "")
		return
	}
	sc.mu.Lock()
	sub := sc.subs[sessionID]
	delete(sc.subs, sessionID)
	sc.mu.Unlock()
	sc.srv.fleet.Unsubscribe(sub) // nil when the client unsubscribes an unknown session
}

// sync re-pushes one subscription's init so a client can rebuild in place.
func (sc *streamConn) sync(f *fleet.ClientFrame) {
	if f.SessionID == "" {
		sc.pushError("bad_request", "sync needs a sessionId", "")
		return
	}
	sc.mu.Lock()
	sub := sc.subs[f.SessionID]
	sc.mu.Unlock()
	if sub == nil {
		sc.pushError("not_subscribed", "", f.SessionID)
		return
	}
	sc.srv.fleet.Resync(sub)
}

// pushError queues one error frame; the connection stays open. SessionID may
// be empty for frame-level refusals that name no session.
func (sc *streamConn) pushError(code, message, sessionID string) {
	frame, _ := json.Marshal(fleet.ErrorFrame{
		Type: fleet.FrameError, SessionID: sessionID, Code: code, Message: message,
	})
	sc.deliver(frame)
}

// teardown releases every subscription when the read loop ends.
func (sc *streamConn) teardown() {
	sc.fail()
	sc.mu.Lock()
	subs := bulk.MapValuesSlice(sc.subs)
	sc.subs = make(map[string]*fleet.Subscription)
	sc.mu.Unlock()
	for _, sub := range subs {
		sc.srv.fleet.Unsubscribe(sub)
	}
}

// writePump owns the socket's writes: subscriber frames and the heartbeat.
func (sc *streamConn) writePump() {
	ticker := time.NewTicker(hbPingEvery)
	defer func() {
		ticker.Stop()
		sc.fail()
	}()
	heartbeat, _ := json.Marshal(fleet.HeartbeatFrame{Type: fleet.FrameHeartbeat}) // constant frame
	for {
		select {
		case <-sc.done:
			return
		case frame := <-sc.send:
			_ = sc.ws.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := sc.ws.WriteMessage(websocket.TextMessage, frame); err != nil {
				return
			}
		case <-ticker.C:
			_ = sc.ws.SetWriteDeadline(time.Now().Add(wsWriteWait))
			if err := sc.ws.WriteMessage(websocket.TextMessage, heartbeat); err != nil {
				return
			}
			// a protocol-level ping as well: browsers pong automatically, so
			// half-open sockets surface on the read side without client code
			_ = sc.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteWait))
		}
	}
}
