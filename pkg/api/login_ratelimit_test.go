package api

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Login and bootstrap share one failed-attempt budget per source address, so
// password guessing and bootstrap spam both slow to the window instead of
// running at wire speed.

func TestLoginRateLimitedAfterFailures(t *testing.T) {
	t.Parallel()

	server, client := newTestAPI(t)
	bootstrapOnly(t, client, server.URL)

	failLogin := func() int {
		code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
			map[string]any{"username": "jent", "password": "wrong"})
		return code
	}

	for i := 0; i < loginFailuresAllowed; i++ {
		require.Equal(t, http.StatusUnauthorized, failLogin())
	}

	code, body := callJSON[errorBody](t, client, server.URL, http.MethodPost, "/api/auth/login",
		map[string]any{"username": "jent", "password": "wrong"})
	assert.Equal(t, http.StatusTooManyRequests, code)
	assert.Equal(t, "rate_limited", body.Error)

	// the right password is refused too: the budget is spent
	code, _ = callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
		map[string]any{"username": "jent", "password": "hunter2"})
	assert.Equal(t, http.StatusTooManyRequests, code)
}

func TestLoginSuccessResetsBudget(t *testing.T) {
	t.Parallel()

	server, client := newTestAPI(t)
	bootstrapOnly(t, client, server.URL)

	burn := func() {
		for i := 0; i < loginFailuresAllowed-1; i++ {
			code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
				map[string]any{"username": "jent", "password": "wrong"})
			require.Equal(t, http.StatusUnauthorized, code)
		}
	}

	burn()
	code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
		map[string]any{"username": "jent", "password": "hunter2"})
	require.Equal(t, http.StatusNoContent, code)

	// the budget restarted: a second run of failures stays below the cap
	burn()
	code, _ = callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/login",
		map[string]any{"username": "jent", "password": "wrong"})
	assert.Equal(t, http.StatusUnauthorized, code)
}

func TestBootstrapRateLimited(t *testing.T) {
	t.Parallel()

	server, client := newTestAPI(t)

	// every bootstrap attempt spends budget (bcrypt cost is the DoS vector),
	// and a success resets it: one 204 then repeated 409s exhaust the cap
	code, _ := callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/bootstrap",
		map[string]string{"password": "hunter2"})
	require.Equal(t, http.StatusNoContent, code)
	for i := 0; i < loginFailuresAllowed; i++ {
		code, _ = callJSON[struct{}](t, client, server.URL, http.MethodPost, "/api/auth/bootstrap",
			map[string]string{"password": fmt.Sprintf("other-%d", i)})
		require.Equal(t, http.StatusConflict, code)
	}

	code, body := callJSON[errorBody](t, client, server.URL, http.MethodPost, "/api/auth/bootstrap",
		map[string]string{"password": "one-more"})
	assert.Equal(t, http.StatusTooManyRequests, code)
	assert.Equal(t, "rate_limited", body.Error)
}

// bootstrapOnly sets the first password without signing in.
func bootstrapOnly(t *testing.T, client *http.Client, baseURL string) {
	t.Helper()
	code, _ := callJSON[struct{}](t, client, baseURL, http.MethodPost, "/api/auth/bootstrap",
		map[string]string{"password": "hunter2"})
	require.Equal(t, http.StatusNoContent, code)
}
