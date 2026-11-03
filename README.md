# ajent-swarm

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jentfoo/ajent-swarm/blob/main/LICENSE)
[![Tests - Main Push](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml/badge.svg)](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml)

Central controller for managing multiple [ajent](https://github.com/jentfoo/ajent) sessions from a browser. Swarm runs on the machine where your agents run and gives you one place to watch them all, jump into any conversation, and put routine prompts on a schedule.

| Desktop tiling | Mobile |
|---|---|
| ![Desktop tiling](docs/img/desktop-tiling.png) | ![Mobile session](docs/img/mobile-session.png) |

The project is deliberately local-first and single-user. It serves one unix account, keeps its state under `<ajent home>/swarm/`, and only talks to ajent sessions living on the same machine. Swarm drives `ajent --serve` children rather than patching or replacing ajent, so a working terminal setup is all you need.

Feedback is welcome. Please open issues if you have any suggestions or comments.

## Why you might like swarm

* You run several agents at once and lose track of which one needs you. Live sessions tile your screen, and anything waiting on an approval surfaces to the top.
* Long runs should not die because a terminal closed or the service restarted. Launched agents keep running on their own and are picked back up automatically.
* Some prompts repeat: a nightly code review, a periodic dependency sweep. The scheduler launches them for you, in any timezone, and keeps the history so you can read what happened later.
* Your desk is not always where the work is. A phone-first mobile view means checking on an agent from the couch or the train, behind TLS.

## Requirements

- Linux or macOS with a unix user account (the login username is fixed to it)
- An `ajent` binary on `PATH`, or pass one via `--ajent-bin`
- Go 1.26+ if building from source
- Node and pnpm only for frontend work, the released binaries embed everything

## Install

Build once and copy the static binary somewhere on `PATH`. There are no runtime dependencies beyond ajent itself:

```sh
make release             # dist/ajent-swarm-<os>-<arch>, statically linked
sudo cp dist/ajent-swarm-$(uname -s | tr A-Z a-z)-$(uname -m | sed s/x86_64/amd64/) \
  /usr/local/bin/ajent-swarm
```

Upgrades are the same steps with the service stopped (`ajent-swarm stop`). State carries over untouched.

### Getting started

For those that would prefer to try `swarm` rather than read the docs:

1. Get ajent working in a terminal first, including at least one conversation with your model of choice. Swarm supervises and drives ajent, it does not configure providers for you.
2. Build and install swarm as shown above, or just run `./bin/ajent-swarm` from this repo after `make build`.
3. Open `http://127.0.0.1:8282` in a browser. The first visit shows a bootstrap form to set your login password (loopback only). Sign in with your unix username.
4. Launch a session from the launcher and type into it like you would in the terminal. Prompts, approvals and mode changes all happen in the browser, while the agent runs headless on the host.
5. When things look good, switch to daemon mode and leave it running:

   ```sh
   ajent-swarm --daemon    # background, logs under <ajent home>/swarm/
   ajent-swarm status      # running or stopped
   ajent-swarm stop        # shut the service down
   ```

## What you can do

* **Watch and drive sessions** - stream output live from every session at once, open any tile to send prompts, answer approval dialogs, rewind to an earlier point or interrupt. Sessions you start in a terminal show up too when ajent's control socket is enabled.
* **Browse history** - saved sessions are listed with their full transcripts even while nothing is running, so yesterday's run stays readable today.
* **Schedule runs** - define one-shot, interval or daily jobs that launch headless ajent runs with your prompt. A run that hits a permission barrier waits and flags you instead of failing. Every run lands in the history view.
* **Work from a phone** - the mobile UI is built for small screens first: a session switcher, touch-sized dialogs and a keyboard-aware composer.

## Remote access from a phone

A phone cannot reach the host's loopback listener, so real devices ride a reverse proxy that terminates TLS and forwards to `127.0.0.1:8282`. The service itself always speaks plain HTTP on localhost, encryption belongs at the edge. Pairing a phone is then just signing in with your unix username.

The first password bootstrap stays loopback-restricted: set it once from the host machine, either through the browser form or `ajent-swarm --password` (prompts without echoing). `--allow-remote-bootstrap` lifts that restriction when you truly must bootstrap from a remote device. Prefer not to, a password typed on a phone crosses any network you do not control.

### Caddy

```
swarm.example.com {
    reverse_proxy 127.0.0.1:8282
}
```

Caddy provisions certificates automatically and the WebSocket stream upgrades through it unchanged.

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

## Configuration

Run `ajent-swarm --help` for the full flag list. The useful knobs:

* `--host` / `--port` - where the service listens, default loopback on 8282
* `--daemon` - run detached in the background instead of the foreground
* `--state` - where state lives, defaulting to `<ajent home>/swarm/`
* `--password` - set or reset the login password from a terminal prompt
* `--kill-children-on-shutdown` - take running agents down when the service exits (they outlive it by default)

Only one instance may run per state directory. The operations handbook in `docs/operations.md` covers log rotation, retention and everything else.

## Development

```sh
make test                 # fast Go unit tests
make test-web             # frontend unit tests (vitest, hermetic)
make web-check            # lint + typecheck + test + build the frontend
make dist                 # build web/ into pkg/web/dist for go:embed
make test-all             # with -race and coverage
make test-e2e             # full smoke: builds ajent + swarm, one turn via Playwright
make lint                 # gofmt + golangci-lint + go vet
```

Building requires an ajent checkout beside this repo (the module replace points there). The e2e smoke additionally needs Playwright browsers once: `cd web && pnpm exec playwright install chromium`. Running it with `SWARM_SHOTS=docs/img make test-e2e` also refreshes the README screenshots.

For frontend work:

```sh
cd web
pnpm install
pnpm dev    # vite dev server on :5173, proxying /api at 127.0.0.1:8282
```

Further reading: `docs/architecture.md`, `docs/operations.md`,
`docs/security-checklist.md`, `docs/performance-notes.md`.
