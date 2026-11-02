package api

import (
	"errors"
	"net/http"

	"github.com/jentfoo/ajent/pkg/ctl"
)

// statusForControl maps one wire refusal onto its HTTP equivalent, so a
// browser can branch on codes instead of parsing prose.
func statusForControl(ce *ctl.Error) int {
	switch ce.Code {
	case ctl.CodeBadRequest:
		return http.StatusBadRequest
	case ctl.CodeNotFound:
		return http.StatusNotFound
	case ctl.CodeUnavailable, ctl.CodeSettled, ctl.CodeBusy,
		ctl.CodeSeatHeld, ctl.CodeObserver:
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}

// writeControlError writes a *ctl.Error with its code and message intact and
// reports whether it handled the error.
func writeControlError(w http.ResponseWriter, err error) bool {
	var ce *ctl.Error
	if !errors.As(err, &ce) {
		return false
	}
	writeError(w, statusForControl(ce), ce.Code, ce.Message)
	return true
}
