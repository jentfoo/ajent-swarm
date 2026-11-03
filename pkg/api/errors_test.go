package api

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/jentfoo/ajent/pkg/ctl"
)

func TestStatusForControl(t *testing.T) {
	t.Parallel()

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
}
