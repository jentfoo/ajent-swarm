# ajent-swarm

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jentfoo/ajent-swarm/blob/main/LICENSE)
[![Tests - Main Push](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml/badge.svg)](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml)

Central controller for managing multiple [ajent](https://github.com/jentfoo/ajent) sessions. Provides a web-ui for monitoring and interacting with ajent sessions running on the local system.

## Status

Phase 02 (service skeleton), phase 03 (fleet manager) and phase 04 (launch and
resume) are implemented: flags, SQLite state store, unix-user auth with bcrypt
passwords, the HTTP server shell serving an embedded placeholder UI, daemon
modes, plus the fleet: a registry watch spawning one actor per live ajent
instance, seat ownership, watermark reconciliation, and a multiplexed
`/api/stream` WebSocket that fans reconciled state out to any number of
viewers. Swarm can now launch `ajent --serve` children (new, resumed,
continued, or create-or-resume by name), track them to exit with captured
logs, stop them through `/exit` with signal fallback, re-adopt them across
restarts, and list saved sessions with offline transcript browsing. The REST
command contract and real frontend arrive in later phases (see `docs/phases/`).

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
make test                 # fast unit tests
make test-all             # with -race and coverage
make test-integration     # env-guarded: builds the binary, exercises daemon mode
make test-integration-fleet # env-guarded: builds ajent, exercises the launch path
make lint                 # gofmt + golangci-lint + go vet
```
