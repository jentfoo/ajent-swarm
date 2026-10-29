export GO111MODULE = on

LDFLAGS := -ldflags "-s -w"

ifneq ($(shell command -v bash),)
test test-all: SHELL := bash
test test-all: .SHELLFLAGS := -o pipefail -c
# Drop the "no test files" noise without swallowing go test's exit code
_FILTER := | { grep -v "no test files" || true; }; exit $${PIPESTATUS[0]}
endif

.PHONY: build clean test test-all test-cover bench fmt-changed lint

build:
	@mkdir -p bin
	go build $(LDFLAGS) -o ./bin/ajent-swarm ./

PLATFORMS := linux-amd64 linux-arm64 darwin-amd64 darwin-arm64

clean:
	rm -rf bin/

test:
	go test -short ./... $(_FILTER)

test-all:
	go test -race -cover ./... $(_FILTER)

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
