# ajent-swarm

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jentfoo/ajent-swarm/blob/main/LICENSE)
[![Tests - Main Push](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml/badge.svg)](https://github.com/jentfoo/ajent-swarm/actions/workflows/tests-main.yml)
[![Vibe-Scale 4.0(V2|U2|T1): Vibed code with gaps](https://img.shields.io/badge/Vibe--Scale%204.0(V2%7CU2%7CT1)-Vibed%20code%20with%20gaps-ff7f0e)](https://github.com/vibesdk/vibe-scale/blob/main/scale/vibe-4.md#v2-u2-t1-score-40--vibed-code-with-gaps)

Central controller for managing multiple [ajent](https://github.com/jentfoo/ajent) sessions from a browser. Swarm runs on the machine where your agents run and gives you one place to watch them all, jump into any conversation, and put routine prompts on a schedule.

The project is deliberately local-first and single-user. It serves one unix account, keeps its state under `~/.ajent/swarm/`, and only talks to ajent sessions living on the same machine. Swarm drives `ajent --serve` children rather than patching or replacing ajent, so a working terminal setup is all you need.

Feedback is welcome. Please open issues if you have any suggestions or comments.

## You might like ajent-swarm if:

* You prefer using `ajent`, and want a way to orchestrate several sessions concurrently.
* You want to automate recurring or scheduled tasks with agent sessions. Get an over-night review of recent work, or periodic deep reviews.
* You want A mobile web view that lets you review and direct ajent sessions away from the computer.

## Requirements

- Linux or macOS with a unix user account (the login username is fixed to it)
- An `ajent` binary on `PATH`, or pass one via `--ajent-bin`
- Go 1.26+ if building from source
- Node and pnpm only for frontend work, the released binaries embed everything

## Install

Build once and copy the static binary into a user-writable directory on `PATH`, no root required. There are no runtime dependencies beyond ajent itself:

```sh
make release             # dist/ajent-swarm-<os>-<arch>, statically linked
install -m 0755 dist/ajent-swarm-$(uname -s | tr A-Z a-z)-$(uname -m | sed s/x86_64/amd64/) \
  ~/.local/bin/ajent-swarm
```

If `~/.local/bin` is not on your `PATH` yet, add it:

```sh
printf 'export PATH="$HOME/.local/bin:$PATH"\n' >> ~/.profile && . ~/.profile
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

## Configuration

Run `ajent-swarm --help` for the full flag list. The useful knobs:

* `--host` / `--port` - where the service listens, default loopback on 8282
* `--daemon` - run detached in the background instead of the foreground
* `--state` - where state lives, defaulting to `<ajent home>/swarm/`
* `--password` - set or reset the login password from a terminal prompt
* `--kill-children-on-shutdown` - take running agents down when the service exits (they outlive it by default)

Only one instance may run per state directory.

