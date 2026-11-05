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

	t.Run("unknown_code_maps_to_500", func(t *testing.T) {
		status := statusForControl(&ctl.Error{Code: "unknown-code"})
		assert.Equal(t, http.StatusInternalServerError, status)
	})
}

func TestErrors(t *testing.T) {
	t.Parallel()

	t.Run("coded_errors_keep_their_code", func(t *testing.T) {
		w := httptest.NewRecorder()
		handled := writeControlError(w, ctl.Errf(ctl.CodeBusy, "queue is full"))
		require.True(t, handled)
		assert.Equal(t, http.StatusConflict, w.Code)

		var body errorBody
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		assert.Equal(t, ctl.CodeBusy, body.Error)
		assert.Contains(t, body.Message, "queue is full")
	})

	t.Run("other_errors_pass_through", func(t *testing.T) {
		w := httptest.NewRecorder()
		handled := writeControlError(w, errors.New("transport lost"))
		assert.False(t, handled)
	})
}
