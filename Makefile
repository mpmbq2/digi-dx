export PATH := $(HOME)/.cargo/bin:$(PATH)
SHELL := /usr/bin/env bash

.PHONY: help ui-deps ui-build ui-check ui-dev build build-debug test lint preflight run clean

help:
	@printf "Digi-Dx v2 Build & Task Targets\n"
	@printf "  make ui-deps      Install frontend npm dependencies\n"
	@printf "  make ui-check     Run TypeScript typecheck in ui/\n"
	@printf "  make ui-build     Build Vite + Preact SPA into ui/dist/\n"
	@printf "  make ui-dev       Start Vite dev server (proxies /api to :8788)\n"
	@printf "  make build        Build UI and compile release digi-dx binary\n"
	@printf "  make build-debug  Build UI and compile debug digi-dx binary\n"
	@printf "  make test         Run Rust unit/integration tests and UI typecheck\n"
	@printf "  make lint         Run rustfmt check, clippy (-D warnings), and install.sh lint\n"
	@printf "  make preflight    Build debug binary and run digi-dx preflight\n"
	@printf "  make run          Build debug binary (with UI) and run digi-dx serve\n"
	@printf "  make clean        Remove Rust target/ and ui/dist/\n"

ui-deps:
	@if [[ -f ui/package-lock.json ]]; then \
		cd ui && npm ci; \
	else \
		cd ui && npm install; \
	fi

ui-check:
	cd ui && npx tsc --noEmit

ui-build:
	@if [[ ! -d ui/node_modules ]]; then $(MAKE) ui-deps; fi
	cd ui && npm run build

ui-dev:
	@if [[ ! -d ui/node_modules ]]; then $(MAKE) ui-deps; fi
	cd ui && npm run dev

build: ui-build
	cargo build --release

build-debug: ui-build
	cargo build

test:
	cargo test
	$(MAKE) ui-check

lint:
	cargo fmt --check
	cargo clippy --all-targets -- -D warnings
	bash -n scripts/install.sh
	@if command -v shellcheck >/dev/null 2>&1; then \
		shellcheck scripts/install.sh; \
	else \
		printf "Note: shellcheck not installed; skipped shellcheck (bash -n passed)\n"; \
	fi

preflight: build-debug
	./target/debug/digi-dx preflight

run: build-debug
	./target/debug/digi-dx serve

clean:
	cargo clean
	rm -rf ui/dist
