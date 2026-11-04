# ajent-swarm

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jentfoo/ajent-swarm/blob/main/LICENSE)
[![Tests - Main Push](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml/badge.svg)](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml)

Central controller for managing multiple [ajent](https://github.com/jentfoo/ajent) sessions. Provides a web-ui for monitoring and interacting with ajent sessions running on the local system.

| Desktop tiling | Mobile |
|---|---|
| ![Desktop tiling](docs/img/desktop-tiling.png) | ![Mobile session](docs/img/mobile-session.png) |

## Status

Phases 02 through 12 are implemented: flags, SQLite state store, unix-user
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
history under bounded retention. The React frontend ships auth screens, a
desktop shell with the focused attention queue and tile workspaces, the scheduler UI,
and a phone-first mobile experience (phase 11): launcher and switcher over one
bottom sheet, touch-sized dialogs, a keyboard-aware composer, swarm-stored
session titles, and remote access behind TLS or a reverse proxy. Phase 12
added the release pass: `stop`/`status` subcommands, log rotation, login rate
limiting, load-test verifications, release packaging, and the docs under
`docs/` (architecture, operations, security checklist, performance notes,
upstream candidates).

## Requirements

- Linux or macOS; a unix user account (the login username is fixed to it)
- Go 1.26+ to build
- An `ajent` binary on `PATH` (or passed via `--ajent-bin`); it is probed with
  `--version` at startup so a missing binary fails loudly

## Install

Build once and copy the static binary somewhere on `PATH`; there are no runtime
dependencies beyond the ajent binary:

```sh
make release             # dist/ajent-swarm-<os>-<arch>, statically linked
sudo cp dist/ajent-swarm-$(uname -s | tr A-Z a-z)-$(uname -m | sed s/x86_64/amd64/) \
  /usr/local/bin/ajent-swarm
```

Upgrades are the same steps with the service stopped (`ajent-swarm stop`);
state under `<ajent home>/swarm/` carries over untouched.

## Running

```sh
make build
./bin/ajent-swarm                 # foreground, logs to stderr, binds 127.0.0.1:8282
./bin/ajent-swarm --daemon        # background, logs to <ajent home>/swarm/swarm.log
./bin/ajent-swarm status          # running or stopped (exit code is the answer)
./bin/ajent-swarm stop            # SIGTERM, escalating to SIGKILL after 10s
```

On first use the browser page offers a bootstrap form (loopback only) to set the
login password for your unix username; `--password` sets it up front instead.
State lives under `<ajent home>/swarm/` (honoring `AJENT_HOME`), overridable via
`--state`. Service and child logs rotate under `--log-max-mb`/`--log-backups`;
run history prunes by `--run-retention-days` and `--run-retention-max`.

Useful flags: `--host`, `--port`, `--pidfile`, `--log`,
`--allow-remote-bootstrap`, `--kill-children-on-shutdown`. Run
`./bin/ajent-swarm --help` for the full list.
Only one instance may run per state directory; a second exits naming the holder.
Operations handbook: `docs/operations.md`.

Launched children join their own process group and outlive the service by
default: a restart of the web service never destroys a running agent run, and
startup re-adopts orphans from the persisted children table. Stopping a session
(from the UI or `POST /api/sessions/{id}/stop`) submits `/exit` through the
control connection, falling back to SIGTERM and SIGKILL for swarm's own
children. `--kill-children-on-shutdown` opts into taking every running child
down when the service exits.

## Remote access from a phone

A phone cannot reach the host's loopback listener, so real devices ride a
reverse proxy that terminates TLS and forwards to `127.0.0.1:8282`. The
service itself always binds plaintext HTTP; encryption belongs at the edge:

```sh
./bin/ajent-swarm --host 127.0.0.1   # default; the proxy is the only peer
```

Logins over TLS (direct or via a proxy that sets `X-Forwarded-Proto: https`)
mark the session cookie `Secure` automatically, so the credential never rides
a plaintext hop. Pairing a phone is then just signing in with your unix
username.

The first password bootstrap stays loopback-restricted: open the web page once
on the host machine and set it there, or pass `--password` at startup.
`--allow-remote-bootstrap` lifts the restriction when you truly must set the
first password from a remote device — prefer not to; a password typed on a
phone crosses any network you do not control.

### Caddy

```
swarm.example.com {
    reverse_proxy 127.0.0.1:8282
}
```

Caddy sets `X-Forwarded-Proto` and provisions certificates automatically; the
WebSocket at `/api/stream` upgrades through it unchanged.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name swarm.example.com;

    location / {
        proxy_pass http://127.0.0.1:8282;
        proxy_http_version 1.1;          # required for the WebSocket upgrade
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 75s;          # keep the stream open past idle beats
    }
}
```

Without `X-Forwarded-Proto: https` the service cannot know the hop is
encrypted and leaves the cookie unmarked, so a direct plaintext login stays
possible but an HTTPS-proxied one always gets the flag.

## Development

```sh
make test                 # fast Go unit tests
make test-web             # frontend unit tests (vitest, hermetic)
make web-check            # lint + typecheck + test + build the frontend
make dist                 # build web/ into pkg/web/dist for go:embed
make test-all             # with -race and coverage, plus load checks
make test-integration     # env-guarded: builds the binary, exercises daemon mode
make test-integration-fleet # env-guarded: builds ajent, exercises the launch path
make test-e2e             # full smoke: builds ajent + swarm, one turn via Playwright
make bench                # Go benchmarks (hub fanout, ...)
make audit                # govulncheck + pnpm audit for both trees
make release              # static binaries for all platforms into dist/
make lint                 # gofmt + golangci-lint + go vet
```

The e2e smoke needs an ajent checkout beside this repo (the module replace
points there) and Playwright browsers once: `cd web && pnpm exec playwright
install chromium`. Running it with `SWARM_SHOTS=docs/img make test-e2e` also
refreshes the README screenshots. Further reading: `docs/architecture.md`,
`docs/operations.md`, `docs/security-checklist.md`,
`docs/performance-notes.md`, `docs/upstream-candidates.md`.

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

