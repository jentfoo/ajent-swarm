export GO111MODULE = on

LDFLAGS := -ldflags "-s -w"

# Package manager for the frontend in web/ (see docs/phases/07-frontend-scaffold.md)
PNPM ?= pnpm

ifneq ($(shell command -v bash),)
test test-all: SHELL := bash
test test-all: .SHELLFLAGS := -o pipefail -c
# Drop the "no test files" noise without swallowing go test's exit code
_FILTER := | { grep -v "no test files" || true; }; exit $${PIPESTATUS[0]}
endif

.PHONY: build clean dist test test-all test-web web-check test-integration test-cover bench fmt-changed lint

build:
	@mkdir -p bin
	go build $(LDFLAGS) -o ./bin/ajent-swarm ./

PLATFORMS := linux-amd64 linux-arm64 darwin-amd64 darwin-arm64

clean:
	rm -rf bin/

# builds the frontend into pkg/web/dist, where go:embed picks it up; run this
# after changing anything under web/ before make build
dist:
	cd web && $(PNPM) install --frozen-lockfile && $(PNPM) build

test:
	go test -short ./... $(_FILTER)

# unit tests for the web app, hermetic: no service or ajent binary needed
test-web:
	cd web && $(PNPM) install --frozen-lockfile && $(PNPM) test

# everything the frontend needs checked in one pass: build (which typechecks),
# then unit tests, lint and format; CI runs this too
web-check:
	$(MAKE) dist
	cd web && $(PNPM) test && $(PNPM) lint && $(PNPM) format:check

test-all:
	go test -race -cover ./... $(_FILTER)

# builds the binary and exercises daemon mode end to end; guarded so unit
# runs stay hermetic (see docs/phases/02-service-skeleton.md)
test-integration:
	AJENT_SWARM_INTEGRATION=1 go test -count=1 -run 'TestDaemonLifecycle' ./pkg/app

# builds ajent and exercises the phase 04 launch path against it; guarded so
# unit runs stay hermetic (see docs/phases/04-launch-resume.md)
test-integration-fleet:
	@mkdir -p bin
	cd ../ajent && go build -o "$(CURDIR)/bin/test-ajent" .
	AJENT_SWARM_TEST_AJENT="$(CURDIR)/bin/test-ajent" go test -count=1 -run 'TestFleetLaunchIntegration' ./pkg/fleet

test-cover:
	go test -race -coverprofile=test.out ./... && go tool cover --html=test.out

BENCHTIME := 10s

bench:
	go test --benchmem -benchtime=$(BENCHTIME) -bench='Benchmark.*' -run='^$$' ./...

fmt-changed:
	@files=$$( { git diff --name-only --diff-filter=d HEAD -- '*.go'; git ls-files --others --exclude-standard -- '*.go'; } | sort -u); \
	if [ -n "$$files" ]; then \
		gofmt -w $$files; \
	fi

lint: fmt-changed
	golangci-lint run --config=.golangci.yml --timeout=600s && GOOS=linux go vet ./...
