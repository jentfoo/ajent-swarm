package api

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	fleettest "github.com/jentfoo/ajent-swarm/pkg/fleet/fleettest"
	"github.com/jentfoo/ajent/pkg/ctl"
)

func TestFleetHandlers(t *testing.T) {
	server, client, home := newFleetAPI(t)

	f := fleettest.New(t, home, fleettest.Options{SessionID: "01ENDPOINT00000000"})
	first := entryOf("01EPENTRYA0000000", "")
	second := entryOf("01EPENTRYB0000000", first.ID)
	f.SetSnapshot(ctl.State{Session: ctl.Session{ID: f.SessionID()}, Model: ctl.ModelState{Key: "p/m"}})
	f.WriteTranscript(t, first, second)
	f.WriteRegistry(t, os.Getpid(), time.Now())

	// the listing shows the session once its actor is online
	waitOnline(t, client, server.URL, f.SessionID())

	t.Run("entries_page_and_cursor", func(t *testing.T) {
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

	t.Run("unknown_session_is_a_404", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, server.URL,
			http.MethodGet, "/api/sessions/01NOBODY00000000/entries", nil)
		assert.Equal(t, http.StatusNotFound, code)

		code, _ = callJSON[struct{}](t, client, server.URL,
			http.MethodPost, "/api/sessions/01NOBODY00000000/take-control", nil)
		assert.Equal(t, http.StatusNotFound, code)
	})

	t.Run("take_control_force_claims", func(t *testing.T) {
		code, _ := callJSON[struct{}](t, client, server.URL,
			http.MethodPost, "/api/sessions/"+f.SessionID()+"/take-control", nil)
		require.Equal(t, http.StatusNoContent, code)
		assert.Equal(t, "swarm", f.SeatHolder())
	})
}
