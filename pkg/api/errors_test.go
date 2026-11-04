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

func TestStatusForControl(t *testing.T) {
	t.Parallel()

	cases := []struct {
		code string
		want int
	}{
		{ctl.CodeBadRequest, http.StatusBadRequest},
		{ctl.CodeNotFound, http.StatusNotFound},
		{ctl.CodeUnavailable, http.StatusConflict},
		{ctl.CodeSettled, http.StatusConflict},
		{ctl.CodeBusy, http.StatusConflict},
		{ctl.CodeSeatHeld, http.StatusConflict},
		{ctl.CodeObserver, http.StatusConflict},
		{"unknown-code", http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			status := statusForControl(&ctl.Error{Code: tc.code})
			assert.Equal(t, tc.want, status)
		})
	}
}

func TestErrors(t *testing.T) {
	t.Run("control error write", func(t *testing.T) {
		t.Run("coded errors keep their code and message", func(t *testing.T) {
			w := httptest.NewRecorder()
			handled := writeControlError(w, ctl.Errf(ctl.CodeBusy, "queue is full"))
			require.True(t, handled)
			assert.Equal(t, http.StatusConflict, w.Code)

			var body errorBody
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
			assert.Equal(t, ctl.CodeBusy, body.Error)
			assert.Contains(t, body.Message, "queue is full")
		})

		t.Run("other errors pass through untouched", func(t *testing.T) {
			w := httptest.NewRecorder()
			handled := writeControlError(w, errors.New("transport lost"))
			assert.False(t, handled)
		})
	})
}
