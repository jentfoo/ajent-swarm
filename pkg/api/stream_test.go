package api

import (
	"encoding/json"
	"net/http"
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
)

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

// readWSRaw pulls one raw stream frame; frames arrive once the handler runs.
func readWSRaw(t *testing.T, ws *websocket.Conn) []byte {
	t.Helper()
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

func TestStream(t *testing.T) {
	t.Run("requires_auth", func(t *testing.T) {
		server, _, _ := newFleetAPI(t)
		// a jarless client: no cookie and no bearer token
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/api/stream", nil)
		require.NoError(t, err)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp.Body.Close() })
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("checks_origin", func(t *testing.T) {
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
	})

	t.Run("subscribe_init_and_events", func(t *testing.T) {
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
	})

	t.Run("heartbeat_flows", func(t *testing.T) {
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
	})

	t.Run("multi_viewer_isolation", func(t *testing.T) {
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
	})
}
