package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/auth"
	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent/pkg/ctl"
	"github.com/jentfoo/ajent/pkg/llm"
	"github.com/jentfoo/ajent/pkg/paths"
	"github.com/jentfoo/ajent/pkg/session"
)

// newFleetAPI builds the full handler over a live fleet manager pointed at a
// temp AJENT_HOME, behind httptest with a cookie-jarred client.
func newFleetAPI(t *testing.T) (*httptest.Server, *http.Client, string) {
	t.Helper()
	home, err := os.MkdirTemp("", "fleet")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv(paths.EnvHome, home)

	svc := newTestService(t)
	fleetMgr := fleet.New(fleet.Options{
		Log:          testLogger(),
		PollInterval: 10 * time.Millisecond,
		BackoffBase:  5 * time.Millisecond,
		BackoffMax:   50 * time.Millisecond,
	})
	fleetMgr.Start(context.Background())
	t.Cleanup(fleetMgr.Stop)

	server := httptest.NewServer(Handler(Config{Auth: svc, Fleet: fleetMgr, Log: testLogger()}))
	t.Cleanup(server.Close)

	jar, err := cookiejar.New(nil)
	require.NoError(t, err)
	client := &http.Client{Jar: jar}
	bootstrapAndLogin(t, client, server.URL)
	return server, client, home
}

// authCookie returns the raw session cookie header value after login.
func authCookie(t *testing.T, client *http.Client, base string) string {
	t.Helper()
	u, err := url.Parse(base)
	require.NoError(t, err)
	for _, c := range client.Jar.Cookies(u) {
		if c.Name == auth.SessionCookieName {
			return c.Name + "=" + c.Value
		}
	}
	t.Fatal("no session cookie in the jar")
	return ""
}

// dialStream opens an authenticated WebSocket to /api/stream.
func dialStream(t *testing.T, base string, header http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	u := "ws" + base[4:] + "/api/stream"
	return websocket.DefaultDialer.Dial(u, header)
}

// readWSRaw pulls one raw stream frame; a stall fails through the deadline.
func readWSRaw(t *testing.T, ws *websocket.Conn) []byte {
	t.Helper()
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	var raw json.RawMessage
	if err := ws.ReadJSON(&raw); err != nil {
		t.Fatalf("read stream frame: %v", err)
	}
	return raw
}

// fleetWire decodes the envelope of any stream frame.
type fleetWire struct {
	Type  string    `json:"type"`
	Code  string    `json:"code,omitempty"`
	Event ctl.Event `json:"event,omitempty"`
}

func readWSFrame(t *testing.T, ws *websocket.Conn) fleetWire {
	t.Helper()
	raw := readWSRaw(t, ws)
	var f fleetWire
	require.NoError(t, json.Unmarshal(raw, &f))
	return f
}

// expectWSFrame drains frames until one of the wanted type arrives.
func expectWSFrame(t *testing.T, ws *websocket.Conn, want string) fleetWire {
	t.Helper()
	for range 50 {
		f := readWSFrame(t, ws)
		if f.Type == want {
			return f
		}
	}
	t.Fatalf("no %s frame arrived", want)
	return fleetWire{}
}

// sendFrame writes one client frame to the socket.
func sendFrame(t *testing.T, ws *websocket.Conn, f fleet.ClientFrame) {
	t.Helper()
	require.NoError(t, ws.WriteJSON(f))
}

// waitOnline blocks until the fleet listing reports the session live.
func waitOnline(t *testing.T, client *http.Client, base, sessionID string) {
	t.Helper()
	require.Eventually(t, func() bool {
		code, body := callJSON[[]map[string]any](t, client, base, http.MethodGet, "/api/sessions", nil)
		if code != http.StatusOK || len(body) != 1 {
			return false
		}
		return body[0]["sessionId"] == sessionID && body[0]["state"] == "online"
	}, 3*time.Second, 20*time.Millisecond)
}

// entryOf builds one committed message transcript entry.
func entryOf(id, parent string) session.Entry {
	data, err := json.Marshal(session.MessageData{Message: llm.Text(llm.RoleUser, "hello")})
	if err != nil { // unreachable for plain message payloads
		panic(err)
	}
	return session.Entry{ID: id, ParentID: parent, Type: session.TypeMessage, Data: data}
}

func TestStreamRequiresAuth(t *testing.T) {
	server, _, _ := newFleetAPI(t)
	// a jarless client: no cookie and no bearer token
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL+"/api/stream", nil)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestStreamChecksOrigin(t *testing.T) {
	server, client, _ := newFleetAPI(t)
	cookie := authCookie(t, client, server.URL)
	ws, resp, err := dialStream(t, server.URL, http.Header{
		"Cookie": []string{cookie},
		"Origin": []string{"http://evil.example"},
	})
	require.Error(t, err) // the handshake itself refuses
	assert.Nil(t, ws)
	if resp != nil {
		t.Cleanup(func() { _ = resp.Body.Close() })
		assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	}
}

func TestStreamSubscribeInitAndEvents(t *testing.T) {
	server, client, home := newFleetAPI(t)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01STREAMTEST00000", Name: "stream"})
	first := entryOf("01STRENTRYA0000000", "")
	second := entryOf("01STRENTRYB0000000", first.ID)
	f.SetSnapshot(ctl.State{
		Session: ctl.Session{ID: f.SessionID()},
		Model:   ctl.ModelState{Key: "p/m"},
	})
	f.WriteTranscript(t, first, second) // the head moves to the newest entry
	f.WriteRegistry(t, os.Getpid(), time.Now())

	// wait for the actor to attach so the subscribe cannot race discovery
	waitOnline(t, client, server.URL, f.SessionID())

	cookie := authCookie(t, client, server.URL)
	ws, _, err := dialStream(t, server.URL, http.Header{"Cookie": []string{cookie}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = ws.Close() })

	sendFrame(t, ws, fleet.ClientFrame{Type: "subscribe", SessionID: f.SessionID()})
	var msg fleet.InitFrame
	require.NoError(t, json.Unmarshal(readWSRaw(t, ws), &msg))
	assert.Equal(t, fleet.FrameInit, msg.Type)
	assert.Equal(t, f.SessionID(), msg.SessionID)
	assert.Equal(t, "p/m", msg.State.Model.Key)
	require.Len(t, msg.Entries, 2) // committed history backfills the init

	// a live event reaches the subscriber verbatim
	f.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: true})
	ev := expectWSFrame(t, ws, "event")
	assert.Equal(t, ctl.EventIdle, ev.Event.Name)

	// sync re-pushes the reconciled state in place
	sendFrame(t, ws, fleet.ClientFrame{Type: "sync", SessionID: f.SessionID()})
	expectWSFrame(t, ws, "init")

	// unknown sessions answer with an error frame; the connection stays open
	sendFrame(t, ws, fleet.ClientFrame{Type: "subscribe", SessionID: "01NOBODY00000000"})
	errFrame := expectWSFrame(t, ws, "error")
	assert.Equal(t, "unknown_session", errFrame.Code)

	// unsubscribe stops delivery for that session only. Resubscribing doubles
	// as the barrier proving the actor served the detach: both ride its mailbox
	// in order, and events applied in between reach no subscriber.
	sendFrame(t, ws, fleet.ClientFrame{Type: "unsubscribe", SessionID: f.SessionID()})
	f.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: false}) // races the detach at worst
	sendFrame(t, ws, fleet.ClientFrame{Type: "subscribe", SessionID: f.SessionID()})
	expectWSFrame(t, ws, "init")

	// live events resume on the fresh subscription
	f.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: true})
	ev = expectWSFrame(t, ws, "event")
	assert.Equal(t, ctl.EventIdle, ev.Event.Name)
}

func TestStreamHeartbeatFlows(t *testing.T) {
	server, client, _ := newFleetAPI(t)

	hbPingEvery = 30 * time.Millisecond
	t.Cleanup(func() { hbPingEvery = defaultPingEvery })

	cookie := authCookie(t, client, server.URL)
	ws, _, err := dialStream(t, server.URL, http.Header{"Cookie": []string{cookie}})
	require.NoError(t, err)
	t.Cleanup(func() { _ = ws.Close() })

	// no subscription needed: the heartbeat is per connection
	raw := readWSRaw(t, ws)
	var f fleetWire
	require.NoError(t, json.Unmarshal(raw, &f))
	assert.Equal(t, "heartbeat", f.Type)
}

func TestStreamMultiViewerIsolation(t *testing.T) {
	server, client, home := newFleetAPI(t)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01MULTIVIEW000000"})
	first := entryOf("01MVENTRYA0000000", "")
	f.SetSnapshot(ctl.State{
		Session: ctl.Session{ID: f.SessionID()},
		Model:   ctl.ModelState{Key: "p/m"},
	})
	f.WriteTranscript(t, first)
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitOnline(t, client, server.URL, f.SessionID())

	cookie := authCookie(t, client, server.URL)
	header := http.Header{"Cookie": []string{cookie}}
	ws1, _, err := dialStream(t, server.URL, header)
	require.NoError(t, err)
	t.Cleanup(func() { _ = ws1.Close() })
	ws2, _, err := dialStream(t, server.URL, header)
	require.NoError(t, err)
	t.Cleanup(func() { _ = ws2.Close() })

	sendFrame(t, ws1, fleet.ClientFrame{Type: "subscribe", SessionID: f.SessionID()})
	sendFrame(t, ws2, fleet.ClientFrame{Type: "subscribe", SessionID: f.SessionID()})
	for _, ws := range []*websocket.Conn{ws1, ws2} {
		var init fleet.InitFrame
		require.NoError(t, json.Unmarshal(readWSRaw(t, ws), &init))
		assert.Equal(t, f.SessionID(), init.SessionID)
	}

	// One viewer leaves; the other keeps streaming.
	sendFrame(t, ws1, fleet.ClientFrame{Type: "unsubscribe", SessionID: f.SessionID()})
	f.Broadcast(ctl.EventIdle, ctl.IdleData{Idle: true})
	ev := expectWSFrame(t, ws2, "event")
	assert.Equal(t, ctl.EventIdle, ev.Event.Name)

	// Refused subscribes name their session, so per-session viewers can route
	// the failure instead of guessing. A racing event may still be queued in
	// front, so drain until the error frame arrives.
	sendFrame(t, ws1, fleet.ClientFrame{Type: "subscribe", SessionID: "01NOBODY00000000"})
	var refused fleet.ErrorFrame
	for range 50 {
		var env struct {
			Type string `json:"type"`
			fleet.ErrorFrame
		}
		require.NoError(t, json.Unmarshal(readWSRaw(t, ws1), &env))
		if env.Type == "error" {
			refused = env.ErrorFrame
			break
		}
	}
	assert.Equal(t, "unknown_session", refused.Code)
	assert.Equal(t, "01NOBODY00000000", refused.SessionID)
}

func TestSessionEndpointsOverFleet(t *testing.T) {
	server, client, home := newFleetAPI(t)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01ENDPOINT00000000"})
	first := entryOf("01EPENTRYA0000000", "")
	second := entryOf("01EPENTRYB0000000", first.ID)
	f.SetSnapshot(ctl.State{Session: ctl.Session{ID: f.SessionID()}, Model: ctl.ModelState{Key: "p/m"}})
	f.WriteTranscript(t, first, second)
	f.WriteRegistry(t, os.Getpid(), time.Now())

	// the listing shows the session once its actor is online
	waitOnline(t, client, server.URL, f.SessionID())

	t.Run("entries page and cursor", func(t *testing.T) {
		code, page := callJSON[struct {
			Entries []json.RawMessage `json:"entries"`
			Cursor  string            `json:"cursor"`
		}](t, client, server.URL, http.MethodGet, "/api/sessions/"+f.SessionID()+"/entries?limit=1", nil)
		require.Equal(t, http.StatusOK, code)
		require.Len(t, page.Entries, 1) // the newest entry first
		assert.Contains(t, string(page.Entries[0]), second.ID)
		assert.NotEmpty(t, page.Cursor)

		code, older := callJSON[struct {
			Entries []json.RawMessage `json:"entries"`
			Cursor  string            `json:"cursor"`
		}](t, client, server.URL, http.MethodGet,
			"/api/sessions/"+f.SessionID()+"/entries?before="+page.Cursor, nil)
		require.Equal(t, http.StatusOK, code)
		require.Len(t, older.Entries, 1) // the walk continues backwards
		assert.Empty(t, older.Cursor)
	})

	t.Run("unknown session is a 404", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, server.URL,
			http.MethodGet, "/api/sessions/01NOBODY00000000/entries", nil)
		assert.Equal(t, http.StatusNotFound, code)

		code, _ = callJSON[struct{}](t, client, server.URL,
			http.MethodPost, "/api/sessions/01NOBODY00000000/take-control", nil)
		assert.Equal(t, http.StatusNotFound, code)
	})

	t.Run("take control force claims", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, server.URL,
			http.MethodPost, "/api/sessions/"+f.SessionID()+"/take-control", nil)
		require.Equal(t, http.StatusNoContent, code)
		assert.Equal(t, "swarm", f.SeatHolder())
	})
}
