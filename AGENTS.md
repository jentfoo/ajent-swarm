## Project Overview

ajent-swarm is a self-hosted, single-user web service for monitoring and driving local ajent
sessions from a desktop or phone. One Go binary serves a REST API plus one multiplexed
WebSocket behind unix-user auth, embeds a React frontend, and runs a persistent scheduler
that launches headless ajent runs on schedule. It supervises `ajent --serve` children and
consumes the sibling ajent module through exported packages only, never carrying local
ajent patches.

Key characteristics:
- Single static binary, CGO-free (pure-Go SQLite), frontend embedded via go:embed from
  `pkg/web/dist` (generated, never committed)
- State under `<ajent home>/swarm/`, one instance per state dir (flock), perms tightened to 0700
- Children in their own process groups, outlive the service by default, re-adopted from
  persisted rows at startup
- Fleet actor model: one actor goroutine per live session, one WebSocket per browser
- Phone-first: PWA manifest, dedicated mobile shell, TLS terminates at a reverse proxy

## Commands

Prerequisite: `go.mod` replaces `github.com/jentfoo/ajent => ../ajent`, so a sibling ajent
checkout is required for any Go build, test or lint. Toolchains: Go 1.26.5, golangci-lint
v2.15.0, pnpm 11, Node 22.

```sh
make build                  # -> ./bin/ajent-swarm; rebuilds web/ into pkg/web/dist when it
                            # changed (a stub lets Go-only targets compile without node)
make dist                   # frontend only -> pkg/web/dist
make release                # static binaries for linux/darwin amd64/arm64 into dist/, CGO off
make test                   # go test -short ./... (hermetic)
make test-all               # adds -race -cover
make test-cover             # coverage profile + HTML report
make test-web               # vitest frontend unit tests
make web-check              # frontend gate: dist build (tsc), vitest, eslint --max-warnings 0, prettier
make test-integration       # AJENT_SWARM_INTEGRATION=1, TestDaemon in pkg/app (skipped in short mode)
make test-integration-fleet # builds ../ajent, passes via AJENT_SWARM_TEST_AJENT to pkg/fleet
make test-e2e               # scripts/e2e.sh: builds both repos, fake provider (8391) + swarm (8382) + Playwright
make bench                  # Go benchmarks
make audit                  # govulncheck + pnpm audit --prod
make lint                   # gofmt changed files (rewrites the tree), golangci-lint + GOOS=linux go vet
```

E2e one-time setup: `cd web && pnpm exec playwright install chromium`.
`SWARM_SHOTS=docs/img make test-e2e` also refreshes the README screenshots.
CI runs `make lint`, rejects any resulting diff, and requires `go mod tidy` to leave
`go.mod`/`go.sum` untouched.

## Architecture

Entry points: `main.go` routes `run`/`stop`/`status` (`stop` and `status` only read the
pidfile, every knob is a flag except `AJENT_SWARM_PASSWORD`), `pkg/app/serve.go` is the one
wiring layer, and the frontend starts at `web/src/main.tsx` → `App.tsx` → providers →
`AuthGate`, which picks mobile or desktop routes by media query.

### Go backend

- `pkg/app`: startup and lifecycle. Wiring order: state dir → logger → pidfile → SQLite
  store → auth → ajent binary probe (`--version`) → fleet → scheduler → API server. On
  shutdown the scheduler stops before the fleet so no run launches into teardown. `--daemon`
  re-execs detached and syncs via a temp ready file (10s bound). The password comes from a
  terminal prompt or `AJENT_SWARM_PASSWORD`, always consumed and unset at startup, never in
  argv. `children.go` adapts `*store.Store` onto fleet's interfaces so fleet never imports
  store.
- `pkg/fleet`: the core. One actor goroutine per live (session, token). View and connection
  state are confined to the actor, everything crosses the mailbox, off-actor reads only via
  atomic status. New actor verbs need a message type, a handler case, and a `Manager`
  wrapper. Watermark rule: events at or below the current seq drop, and an `init` frame
  replaces all client state because ajent renumbers seq per instance. Fail-open: an
  overflowing subscriber queue drops the viewer's connection, never the session. Seat
  policy: swarm force-claims the seat (holder `swarm`) only for children it spawned, a held
  seat surfaces a coded refusal rather than being displaced, and swarm never signals a
  process it did not spawn. Also owns launch/stop, swarm-side titles, settings and the
  one-shot auto-namer (never touches ajent's own session names), the server-side attention
  ledger and digest kinds (any device's check-off settles every device), parked prompts (the
  composer's Queue action holds them until the whole fleet has been quiet for 1 minute
  through the same gate as jobs' run-when-idle 10-minute hold, releasing one line per
  idle point; a reconnect re-arms it), saved-transcript
  browsing, the rewind picker, model/tool unions, and composer `@`-file completion.
  `fleettest/` provides a stub control-socket server for tests.
- `pkg/sched`: one trigger goroutine claims due jobs, applies an optional shell trigger
  gate, launches through the `Runner` interface (satisfied by `*fleet.Manager`), applies
  custom tool sets, submits with a deterministic `run-<id>` pending id, and watches the
  stream until the run lands, parks at a dialog as `awaiting_input`, times out, or ends. It
  stops the session afterwards unless the job sets `keep_alive`. Its stream watcher
  implements the same watermark machine as the TS session store, keep them in step.
- `pkg/store`: SQLite persistence (leaf, imports only stdlib + the driver). One connection
  (`SetMaxOpenConns(1)`), WAL, embedded numbered migrations. Job timestamps are unix
  seconds, run timestamps are unix milliseconds. `StartScheduledFire` claims a job and
  inserts its run row in one transaction so restarts never double-fire.
- `pkg/api`: HTTP surface. One route table in `handler.go` registers every endpoint and
  derives the 405 `Allow` sets. Unmatched `/api/` paths answer JSON, never the SPA. Errors
  use the `{error, message}` envelope and clients branch on codes. Request bodies are
  strict JSON (`DisallowUnknownFields`, 1 MiB cap). List replies encode `[]`, not null.
  `/api/stream` is one WebSocket per browser carrying ids only (16 KiB frames), same-origin
  upgrades, no global write deadline so streams survive.
- `pkg/auth`: one unix user, one bcrypt password (cost 12, 72-byte max), sha256-hashed
  `swt_` bearer tokens, cookie `swarm_session` (HttpOnly, SameSite=Lax, 7-day sliding
  expiry). Until bootstrapped only `/api/auth/bootstrap` is reachable (everything else 503),
  and bootstrap is loopback-only unless `--allow-remote-bootstrap`. Cookie-authenticated
  unsafe methods must pass a Fetch-Metadata same-origin check. Failed logins are limited to
  10 per 5 minutes per source.
- `pkg/logrotate`: rotation helpers (leaf). An owning `Writer` for service logs, copytruncate
  `TruncateRotate` for child logs held open by other processes.
- `pkg/web`: serves the embedded `dist/`. SPA fallback applies only to extension-less and
  directory paths, so a broken asset reference stays a visible 404. Caching is two classes:
  only `/assets/` carries `immutable` caching, the SPA document and root statics answer
  `no-cache` with a strong ETag over the embedded bytes so an upgraded binary wins on the
  next visit. The CSP pins a sha256 hash of the inline `theme-bootstrap` script in
  `index.html`, and `web_test.go` recomputes that hash from the built document, so changing
  that script requires updating `contentSecurityPolicy`.

### Frontend (`web/`, Vite + React 19 + react-router 7)

Strict acyclic layering: `api/` (leaf: typed client, endpoint table mirroring the Go
routes, wire types) → `state/` → `ui/` → `workspace/` and `jobs/` → `mobile/`, with
`session/` (chat surface) and `shell/` (chrome) above.

- `state/eventApplier.ts` is the single transcription of the reconciliation contract:
  `init` replaces everything and resets the watermark, events apply only above it,
  snapshots merge poll-only facts unconditionally and event-covered fields only when
  fresh, optimistic submit rows resolve by id never text, live-to-committed handoff is
  exactly-once, and it stays idempotent under React replay. `derive.ts` builds the visible
  transcript blocks.
- `providers/`: auth (gate state, any 401 drops to anon), swarm (owns the one `SwarmStream`
  plus `SessionStore`, polling, theme), workspace (attention model, title-bar badge,
  notifications). `stream/swarmStream.ts` is the single multiplexed WebSocket:
  reference-counted subscriptions, heartbeat watchdog, backoff, resync on tab visibility.
- `workspace/attention.ts` is the one attention model, consumed by the desktop rail, tile
  badges, notifications, and the mobile switcher. Kinds, reasons and waits arrive derived
  on the `/api/attention` digest against the server-side acknowledgment ledger
  (`POST /api/attention/ack`), so every device renders one attention state; only queue-entry
  stamping stays client-side. Cross-surface agreements are shared, never copied: attention
  ordering, model menus, `phaseText` for transient phases, `names.ts` display names, and the
  tools widen-only derivation.
- `ui/overlayStack.ts` is the one overlay layer order behind ModalShell, MenuPopover and
  the mobile sheets and pushed screens: only the topmost layer answers Escape, key
  bindings that act on page content stand down behind any open layer, and closing
  returns focus to the opener. `ui/useOverlayBack.ts` rides that contract, pushing one
  history entry per overlay so platform back closes the topmost layer instead of
  leaving the page; mobile menus and sheets bind it through OverlayMenu, BottomSheet
  and friends, and shared surfaces branch on pointer coarseness.
- The 48rem mobile breakpoint is duplicated in `styles/theme.css` (change both together).
- Session surfaces key the inner component on `sessionId` so a swap remounts: drafts
  restore from the store while sheets, menus and toasts reset.
- Composer drafts persist per session in localStorage and clear only when a submit is
  accepted. Oversize drafts stay memory-only rather than truncating.
- Model output renders through the sanitizer with raw HTML disabled. Hard requirement, the
  content is untrusted.
- localStorage keys are versioned (`swarm.workspace.v1`); corrupt or unreadable storage
  degrades to defaults, never throws. The pre-paint theme script in `index.html` is pinned
  by a test to SwarmProvider's logic.
- `jobs/` validation mirrors but never overrides the server. Duplicated jobs are forced
  disabled. Recurring updates omit `nextRunAt` so the server recomputes the slot.

## Code Style

- Use `var` style for zero-value initialization: `var foo bool`, not `foo := false`. Applies to every type.
- Comments should be concise simple and short phrases rather than full sentences when possible
- Comments should only be added when they describe non-obvious context, not a single line of code
- Wrap comments at ~100 columns
- Godocs should only describe usage (the inputs and outputs), not how the function is implemented
- Follow existing naming conventions and neighboring code style

Frontend: Prettier enforces no semicolons at 100 columns. ESLint runs with
`--max-warnings 0`. TypeScript is strict with `noUnusedLocals`/`noUnusedParameters` and
`verbatimModuleSyntax`.

golangci-lint uses the v2 config (~30 linters), with `goconst` excluded in `_test.go`.

## Collection handling

Reach for stdlib `slices`/`maps`/`strings` and `github.com/go-analyze/bulk` before writing a manual loop. The patterns below come up often:

- **Clone a slice or map**: `slices.Clone(src)` / `maps.Clone(src)`.
- **Filter a slice (same element type, no transformation)**: `bulk.SliceFilter(predicate, s)`. Use `bulk.SliceFilterInPlace` when the caller doesn't reuse the input backing array. Use instead of `for _, v := range s { if cond { out = append(out, v) } }`.
- **Slice → map set**: `bulk.SliceToSet(s)` (returns `map[T]struct{}`). Membership tests use the comma-ok form: `if _, ok := set[k]; ok`.
- **Map → slice of keys / values**: `bulk.MapKeysSlice(m)` and `bulk.MapValuesSlice(m)`.
- **Membership check on a slice**: `slices.Contains(s, x)` for comparable element types, `slices.ContainsFunc(s, predicate)` for everything else.
- **Sort a slice with a custom comparator**: `slices.SortFunc(s, cmp)` / `slices.SortStableFunc(s, cmp)`. Use instead of `sort.Slice` / `sort.SliceStable`.

## Testing

Structure and conventions:
- One `_test.go` file per implementation file that requires testing
- One `func Test<FunctionName>` per target function, using table-driven tests or `t.Run` cases
- Test case names should be at most 3 to 5 words and in lower case with underscores
- Use `t.Parallel()` at test function start when no shared state, but not in the test cases
- Isolated temp directories via `t.TempDir()` when needed
- Context timeouts via `t.Context()` for tests with I/O
- Cleanup actions should be done with t.Cleanup, not defer

Assertions and validation:
- Assertions rely on `testify` (`require` for setup, `assert` for assertions)
- Don't include assertion messages unless the message provides context outside of the test point
- Do NOT use time.Sleep for tests, instead use require.Eventually or deterministic triggers
- Check returned errors with `require.NoError` / `assert.NoError` whenever `*testing.T` is in scope. Exceptions: `t.Cleanup` and goroutines.

Test helpers:
- `pkg/testutil.IsolateHome(t)` pins `AJENT_HOME` so tests never touch the real ajent home
- `web/src/test/mockWebSocket.ts` is the shared WebSocket test double
- `web/tests/setup.ts` fixes element geometry so the virtualizer is deterministic in jsdom
- `resetDrafts()` resets localStorage-backed state between tests

Verification:
- Verify with `make test-all` and `make lint` (frontend: `make web-check`) before considering a change complete
