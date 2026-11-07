package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/jentfoo/ajent/pkg/ctl"
)

func TestErrors(t *testing.T) {
	t.Parallel()

	t.Run("status_maps_control_codes", func(t *testing.T) {
		cases := []struct {
			name string
			code string
			want int
		}{
			{"bad_request", ctl.CodeBadRequest, http.StatusBadRequest},
			{"not_found", ctl.CodeNotFound, http.StatusNotFound},
			{"unavailable_conflicts", ctl.CodeUnavailable, http.StatusConflict},
			{"settled_conflicts", ctl.CodeSettled, http.StatusConflict},
			{"busy_conflicts", ctl.CodeBusy, http.StatusConflict},
			{"seat_held_conflicts", ctl.CodeSeatHeld, http.StatusConflict},
			{"observer_conflicts", ctl.CodeObserver, http.StatusConflict},
			{"unknown_code", "no-such-code", http.StatusInternalServerError},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				assert.Equal(t, tc.want, statusForControl(&ctl.Error{Code: tc.code}))
			})
		}
	})

	t.Run("coded_errors_keep_their_code", func(t *testing.T) {
		w := httptest.NewRecorder()
		writeCommandFailure(w, ctl.Errf(ctl.CodeBusy, "queue is full"))
		assert.Equal(t, http.StatusConflict, w.Code)

		var body errorBody
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		assert.Equal(t, ctl.CodeBusy, body.Error)
		assert.Contains(t, body.Message, "queue is full")
	})

	t.Run("other_errors_answer_internal", func(t *testing.T) {
		w := httptest.NewRecorder()
		writeCommandFailure(w, errors.New("transport lost"))
		assert.Equal(t, http.StatusInternalServerError, w.Code)
	})
}
