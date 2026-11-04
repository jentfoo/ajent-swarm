package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// maxBodyBytes bounds every request body; the API carries small JSON only.
const maxBodyBytes = 1 << 20

// errorBody is the one error envelope every failure uses, so clients branch
// on codes instead of parsing prose.
type errorBody struct {
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// writeJSON encodes v as a JSON response body. Encode failures after the
// status line are unrecoverable by design; only unreachable types hit them.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError answers with the standard envelope.
func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Error: code, Message: message})
}

// orEmptySlice replaces a typed nil slice with an empty one so list replies
// encode as [] rather than null.
func orEmptySlice[T any](rows []T) []T {
	if rows == nil {
		return []T{}
	}
	return rows
}

// readRequest decodes a strict JSON body into dst. Unknown fields and
// oversize bodies are rejected so typos surface instead of silently no-ops.
func readRequest(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeBody(w, r, dst, true)
}

// readOptionalRequest decodes a strict JSON body that may be absent, for
// endpoints whose whole payload is optional.
func readOptionalRequest(w http.ResponseWriter, r *http.Request, dst any) bool {
	return decodeBody(w, r, dst, false)
}

// decodeBody shares the strict decoding both request readers apply; require
// decides whether a missing body is an error.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any, require bool) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooBig *http.MaxBytesError
		switch {
		case errors.As(err, &tooBig):
			writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", tooBig.Error())
		case errors.Is(err, io.EOF) && !require:
			return true // an empty body leaves dst at its zero value
		case errors.Is(err, io.EOF):
			writeError(w, http.StatusBadRequest, "invalid_request", "expected a JSON body")
		default:
			writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		}
		return false
	}
	return true
}
