# ajent-swarm

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jentfoo/ajent-swarm/blob/main/LICENSE)
[![Tests - Main Push](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml/badge.svg)](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml)

Central controller for managing multiple [ajent](https://github.com/jentfoo/ajent) sessions. Provides a web-ui for monitoring and interacting with ajent sessions running on the local system.

## Status

Phases 02 through 07 are implemented: flags, SQLite state store, unix-user
auth with bcrypt passwords, daemon modes, and the fleet (a registry watch
spawning one actor per live ajent instance, seat ownership, watermark
reconciliation, and a multiplexed `/api/stream` WebSocket that fans reconciled
state out to any number of viewers). Swarm can launch `ajent --serve` children
(new, resumed, continued, or create-or-resume by name), track them to exit with
captured logs, stop them through `/exit` with signal fallback, re-adopt them
across restarts, and list saved sessions with offline transcript browsing; the
full command API proxies submit, interrupt, mode changes, rewind, dialogs and
recalls onto live sessions. A persistent scheduler defines jobs (one-shot,
interval or daily in any IANA zone) that launch headless runs on schedule with
optional shell prefixes and prompts, watch them settle through the control
socket, park at permission barriers as `awaiting_input`, and record full run
history under bounded retention. The React frontend ships auth screens, the
desktop and mobile shells, a sessions home, and the stateful core (a shared
stream client with per-session reference counting plus a fixture-tested
EventApplier) that later UI phases build on.

## Requirements

- Linux or macOS; a unix user account (the login username is fixed to it)
- Go 1.26+ to build
- An `ajent` binary on `PATH` (or passed via `--ajent-bin`); it is probed with
  `--version` at startup so a missing binary fails loudly

## Running

```sh
make build
./bin/ajent-swarm                 # foreground, logs to stderr, binds 127.0.0.1:8282
./bin/ajent-swarm --daemon        # background, logs to <ajent home>/swarm/swarm.log
```

On first use the browser page offers a bootstrap form (loopback only) to set the
login password for your unix username; `--password` sets it up front instead.
State lives under `<ajent home>/swarm/` (honoring `AJENT_HOME`), overridable via
`--state`.

Useful flags: `--host`, `--port`, `--pidfile`, `--log`,
`--allow-remote-bootstrap`, `--kill-children-on-shutdown`. Run
`./bin/ajent-swarm --help` for the full list.
Only one instance may run per state directory; a second exits naming the holder.

Launched children join their own process group and outlive the service by
default: a restart of the web service never destroys a running agent run, and
startup re-adopts orphans from the persisted children table. Stopping a session
(from the UI or `POST /api/sessions/{id}/stop`) submits `/exit` through the
control connection, falling back to SIGTERM and SIGKILL for swarm's own
children. `--kill-children-on-shutdown` opts into taking every running child
down when the service exits.

## Development

```sh
make test                 # fast Go unit tests
make test-web             # frontend unit tests (vitest, hermetic)
make web-check            # lint + typecheck + test + build the frontend
make dist                 # build web/ into pkg/web/dist for go:embed
make test-all             # with -race and coverage
make test-integration     # env-guarded: builds the binary, exercises daemon mode
make test-integration-fleet # env-guarded: builds ajent, exercises the launch path
make lint                 # gofmt + golangci-lint + go vet
```

### Frontend

The UI lives in `web/` (Vite, React, TypeScript). Build output goes to
`pkg/web/dist`, which is generated not committed: Go-only targets compile
against a minimal placeholder and `make build` rebuilds the real bundle
automatically whenever `web/` changes. Frontend work needs pnpm
(`PNPM=... make dist` overrides).

```sh
cd web
pnpm install
pnpm dev    # vite dev server on :5173, proxying /api (and the stream) at 127.0.0.1:8282
```

