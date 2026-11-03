package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent-swarm/pkg/fleet"
	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent/pkg/ctl"
)

// Phase 12 fanout load check: many concurrent viewers on one session must all
// receive the committed event burst verbatim, in seq order, inside a generous
// wall budget. The hub coalesces ephemeral deltas by design, so the burst
// rides committed entry.append events, which forward verbatim.

func TestFanoutManyViewersOneSession(t *testing.T) {
	if testing.Short() {
		t.Skip("fanout load check skipped in -short runs")
	}

	const (
		viewers = 24
		// stays under fleet's per-subscription queue (256): a forwarder that
		// loses the CPU mid-burst must never trip fail-open in a delivery
		// test. Overload drop semantics live in the slow-viewer test.
		eventBurst   = 240
		fanoutBudget = 30 * time.Second
	)

	server, client, home := newFleetAPI(t)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01FANOUTTEST00000"})
	f.SetSnapshot(ctl.State{
		Session: ctl.Session{ID: f.SessionID()},
		Model:   ctl.ModelState{Key: "p/m"},
	})
	root := entryOf("01FANROOT000000000", "")
	f.WriteTranscript(t, root)
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitOnline(t, client, server.URL, f.SessionID())

	cookie := authCookie(t, client, server.URL)
	header := http.Header{"Cookie": []string{cookie}}

	type viewer struct {
		ws    *websocket.Conn
		seqs  chan uint64
		count int
	}
	vs := make([]*viewer, viewers)
	readers := make(chan error, viewers)
	for i := range vs {
		ws, _, err := dialStream(t, server.URL, header)
		require.NoError(t, err)
		t.Cleanup(func() { _ = ws.Close() })
		sendFrame(t, ws, fleet.ClientFrame{Type: "subscribe", SessionID: f.SessionID()})

		var init fleet.InitFrame
		_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		require.NoError(t, json.Unmarshal(readWSRaw(t, ws), &init))
		require.Equal(t, fleet.FrameInit, init.Type, "viewer %d init", i)

		v := &viewer{ws: ws, seqs: make(chan uint64, eventBurst)}
		vs[i] = v
		go func(v *viewer) {
			for {
				_ = v.ws.SetReadDeadline(time.Now().Add(fanoutBudget))
				var raw json.RawMessage
				if err := v.ws.ReadJSON(&raw); err != nil {
					readers <- err
					return
				}
				var frame struct {
					Type  string `json:"type"`
					Event struct {
						Seq uint64 `json:"seq"`
					} `json:"event"`
				}
				if err := json.Unmarshal(raw, &frame); err != nil {
					readers <- err
					return
				}
				if frame.Type == "event" {
					v.seqs <- frame.Event.Seq
					v.count++
					if v.count >= eventBurst {
						readers <- nil
						return
					}
				}
			}
		}(v)
	}

	// the burst: committed appends forward verbatim to every subscriber
	start := time.Now()
	for i := 0; i < eventBurst; i++ {
		f.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
			ID:       fmt.Sprintf("01FANEV%08d", i),
			ParentID: root.ID,
			Type:     "message",
			TS:       int64(1730000000000 + i),
		}})
	}

	for i := range vs {
		select {
		case err := <-readers:
			require.NoError(t, err, "viewer %d stopped early", i)
		case <-time.After(fanoutBudget):
			t.Fatalf("viewer %d never saw the full burst", i)
		}
	}
	t.Logf("fanout: %d viewers x %d committed events in %s", viewers, eventBurst, time.Since(start))

	// every viewer saw strictly increasing seq values covering the burst
	for i, v := range vs {
		close(v.seqs)
		prev := uint64(0)
		n := 0
		for seq := range v.seqs {
			assert.Greater(t, seq, prev, "viewer %d seq regressed", i)
			prev = seq
			n++
		}
		assert.Equal(t, eventBurst, n, "viewer %d event count", i)
	}
}

func TestFanoutSlowViewerDoesNotStallOthers(t *testing.T) {
	if testing.Short() {
		t.Skip("fanout load check skipped in -short runs")
	}

	server, client, home := newFleetAPI(t)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01FANSLOWTEST0000"})
	f.SetSnapshot(ctl.State{
		Session: ctl.Session{ID: f.SessionID()},
		Model:   ctl.ModelState{Key: "p/m"},
	})
	root := entryOf("01FANSLOWROOT00000", "")
	f.WriteTranscript(t, root)
	f.WriteRegistry(t, os.Getpid(), time.Now())
	waitOnline(t, client, server.URL, f.SessionID())

	cookie := authCookie(t, client, server.URL)
	header := http.Header{"Cookie": []string{cookie}}

	// pin both ends of the stalled viewer's socket small: its write pump
	// wedges on the closed TCP window instead of hiding frames in autotuned
	// kernel buffers, so the bounded app queues overflow and the fail-open
	// rule drops it. The live viewer keeps default buffering.
	defer func(prev func(*http.Request, net.Conn)) { wsConnSetup = prev }(wsConnSetup)
	stallHeader := header.Clone()
	stallHeader.Set("X-Swarm-Test-Stall", "1")
	wsConnSetup = func(r *http.Request, c net.Conn) {
		if r.Header.Get("X-Swarm-Test-Stall") == "" {
			return
		}
		if tcp, ok := c.(*net.TCPConn); ok {
			_ = tcp.SetReadBuffer(4096)
			_ = tcp.SetWriteBuffer(4096)
		}
	}

	// the stalled viewer subscribes and then stops reading
	big := append(append([]byte{'"'}, bytes.Repeat([]byte("x"), 16<<10)...), '"')
	stalled, _, err := dialStream(t, server.URL, stallHeader)
	require.NoError(t, err)
	t.Cleanup(func() { _ = stalled.Close() })
	sendFrame(t, stalled, fleet.ClientFrame{Type: "subscribe", SessionID: f.SessionID()})
	expectWSFrame(t, stalled, "init")

	// a live viewer shares the session and keeps receiving
	live, _, err := dialStream(t, server.URL, header)
	require.NoError(t, err)
	t.Cleanup(func() { _ = live.Close() })
	sendFrame(t, live, fleet.ClientFrame{Type: "subscribe", SessionID: f.SessionID()})
	expectWSFrame(t, live, "init")

	// the burst goes out in waves bounded by the live viewer's own progress:
	// a wave is far smaller than any one queue, and the next wave only fires
	// once the live reader drained the last one, so no healthy viewer can
	// ever fall behind enough to trip fail-open, however loaded the box is.
	const (
		burst = 256 + sendQueueSize + 64 // past q plus conn channel: overflow is certain
		wave  = 64
	)

	var seen atomic.Int64
	readDone := make(chan error, 1)
	go func() {
		_ = live.SetReadDeadline(time.Now().Add(30 * time.Second))
		for {
			var raw json.RawMessage
			if err := live.ReadJSON(&raw); err != nil {
				readDone <- err
				return
			}
			var frame struct {
				Type  string `json:"type"`
				Event struct {
					Name string `json:"event"`
				} `json:"event"`
			}
			if err := json.Unmarshal(raw, &frame); err != nil {
				readDone <- err
				return
			}
			if frame.Type == "event" && frame.Event.Name == ctl.EventEntryAppend {
				seen.Add(1)
			}
		}
	}()

	// drainBarrier waits until the live viewer observed every event so far,
	// or reports a reader that died mid-burst.
	drainBarrier := func(n int64) {
		t.Helper()
		require.Eventually(t, func() bool {
			select {
			case err := <-readDone:
				require.NoError(t, err, "live viewer stopped early at %d/%d", seen.Load(), burst)
			default:
			}
			return seen.Load() >= n
		}, 10*time.Second, 500*time.Microsecond)
	}

	start := time.Now()
	for from := 0; from < burst; from += wave {
		to := min(from+wave, burst)
		for i := from; i < to; i++ {
			f.Broadcast(ctl.EventEntryAppend, ctl.EntryData{Entry: ctl.Entry{
				ID:       fmt.Sprintf("01FANDROP%06d", i),
				ParentID: root.ID,
				Type:     "message",
				TS:       int64(1730000000000 + i),
				Data:     big,
			}})
		}
		drainBarrier(int64(to))
	}

	// the live viewer rode through the whole burst
	assert.Equal(t, int64(burst), seen.Load())

	// the stalled connection closed under the same load: reading fails once
	// the server tore it down
	// the stalled connection closed under the same load: reading fails well
	// inside the deadline, and not because the deadline itself ran out
	_ = stalled.SetReadDeadline(time.Now().Add(10 * time.Second))
	var readErr error
	for {
		if _, _, err := stalled.ReadMessage(); err != nil {
			readErr = err
			break
		}
	}
	require.Error(t, readErr)
	var ne net.Error
	require.False(t, errors.As(readErr, &ne) && ne.Timeout(),
		"the stalled connection was never dropped by the fail-open rule")
	t.Logf("stalled viewer dropped after %s", time.Since(start))
}
