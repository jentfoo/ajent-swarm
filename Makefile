export GO111MODULE = on

LDFLAGS := -ldflags "-s -w"

# Package manager for the frontend in web/ (see docs/phases/07-frontend-scaffold.md)
PNPM ?= pnpm

# Frontend build wiring. pkg/web/dist is generated, never committed; a stamp
# file lets make build rerun pnpm only when web sources actually changed.
DIST := pkg/web/dist
WEB_SRC := $(shell find web -name node_modules -prune -o -type f -print 2>/dev/null)
WEB_STAMP := pkg/web/.dist-stamp
REAL_OK := $(shell test -f $(DIST)/index.html && test ! -e $(DIST)/assets/stub.js && echo yes)
ifeq ($(REAL_OK),yes)
STAMP_FORCE :=
else
# always-remade prereq that forces pnpm to run when dist lacks a real bundle
STAMP_FORCE := FORCE
endif

ifneq ($(shell command -v bash),)
test test-all: SHELL := bash
test test-all: .SHELLFLAGS := -o pipefail -c
# Drop the "no test files" noise without swallowing go test's exit code
_FILTER := | { grep -v "no test files" || true; }; exit $${PIPESTATUS[0]}
endif

.PHONY: build clean dist test test-all test-web web-check test-integration test-integration-fleet test-e2e audit release release-clean test-cover bench fmt-changed lint FORCE
FORCE:

build: $(WEB_STAMP) | embed-stubs
	@mkdir -p bin
	go build $(LDFLAGS) -o ./bin/ajent-swarm ./

PLATFORMS := linux-amd64 linux-arm64 darwin-amd64 darwin-arm64

# release builds one static binary per platform with the frontend embedded;
# CGO stays off (modernc.org/sqlite is pure Go) and output lands in dist/
release: $(WEB_STAMP) | embed-stubs
	mkdir -p dist
	@for platform in $(PLATFORMS); do \
		os=$${platform%-*}; arch=$${platform#*-}; \
		echo "==> dist/ajent-swarm-$$platform"; \
		GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 \
			go build $(LDFLAGS) -trimpath -o dist/ajent-swarm-$$platform ./ || exit 1; \
	done

release-clean:
	rm -rf dist/

clean:
	rm -rf bin/ $(DIST)/ $(WEB_STAMP)

# builds the frontend into pkg/web/dist for go:embed; make build runs it
# automatically when web sources changed, delete the stamp to force a rerun
dist: $(WEB_STAMP)

$(WEB_STAMP): $(WEB_SRC) $(STAMP_FORCE)
	cd web && $(PNPM) install --frozen-lockfile && $(PNPM) build
	rm -f $(DIST)/assets/stub.js
	@touch $@

# placeholder embed payload so Go-only targets compile without node. Phony so
# it re-evaluates every make run, self-healing if dist is wiped; the guard
# means a real vite bundle (always has index.html) can never be clobbered.
.PHONY: embed-stubs
embed-stubs:
	@if [ ! -f $(DIST)/index.html ]; then \
		mkdir -p $(DIST)/assets; \
		printf '<!doctype html>\n<html><body>frontend not built: run make dist</body>\n<script src="/assets/stub.js"></script></html>\n' > $(DIST)/index.html; \
		printf '// placeholder build output; run make dist for the real bundle\n' > $(DIST)/assets/stub.js; \
		printf '<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/></svg>\n' > $(DIST)/favicon.svg; \
	fi

test: | embed-stubs
	go test -short ./... $(_FILTER)

# unit tests for the web app, hermetic: no service or ajent binary needed
test-web:
	cd web && $(PNPM) install --frozen-lockfile && $(PNPM) test

# everything the frontend needs checked in one pass: build (which typechecks),
# then unit tests, lint and format; CI runs this too
web-check:
	$(MAKE) dist
	cd web && $(PNPM) test && $(PNPM) lint && $(PNPM) format:check

test-all: | embed-stubs
	go test -race -cover ./... $(_FILTER)

# builds the binary and exercises daemon mode end to end; guarded so unit
# runs stay hermetic (see docs/phases/02-service-skeleton.md)
test-integration: | embed-stubs
	AJENT_SWARM_INTEGRATION=1 go test -count=1 -run 'TestDaemonLifecycle' ./pkg/app

# builds ajent and exercises the phase 04 launch path against it; guarded so
# unit runs stay hermetic (see docs/phases/04-launch-resume.md)
test-integration-fleet: | embed-stubs
	@mkdir -p bin
	cd ../ajent && go build -o "$(CURDIR)/bin/test-ajent" .
	AJENT_SWARM_TEST_AJENT="$(CURDIR)/bin/test-ajent" go test -count=1 -run 'TestFleetLaunchIntegration' ./pkg/fleet

# full UI smoke: builds ajent + swarm, drives one turn through Playwright
# (see docs/phases/12-polish-hardening.md); needs browsers once via
# `cd web && pnpm exec playwright install chromium`. SWARM_SHOTS=docs/img also
# refreshes the README screenshots.
test-e2e: | embed-stubs
	SWARM_SHOTS=$(SWARM_SHOTS) ./scripts/e2e.sh

# dependency audits for both trees, recording current advisories
audit: | embed-stubs
	go run golang.org/x/vuln/cmd/govulncheck@latest ./...
	cd web && $(PNPM) audit --prod

test-cover: | embed-stubs
	go test -race -coverprofile=test.out ./... && go tool cover --html=test.out

BENCHTIME := 10s

bench: | embed-stubs
	go test --benchmem -benchtime=$(BENCHTIME) -bench='Benchmark.*' -run='^$$' ./...

fmt-changed:
	@files=$$( { git diff --name-only --diff-filter=d HEAD -- '*.go'; git ls-files --others --exclude-standard -- '*.go'; } | sort -u); \
	if [ -n "$$files" ]; then \
		gofmt -w $$files; \
	fi

lint: fmt-changed | embed-stubs
	golangci-lint run --config=.golangci.yml --timeout=600s && GOOS=linux go vet ./...
