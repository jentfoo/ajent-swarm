package api

import (
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
