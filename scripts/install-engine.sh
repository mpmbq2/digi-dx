#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/scripts/engine-versions.env" ]]; then
  # shellcheck source=scripts/engine-versions.env
  source "$ROOT_DIR/scripts/engine-versions.env"
fi

FT8MODEM_TARBALL="${FT8MODEM_TARBALL:-ft8modem-20250720-1.0.10395.tar.gz}"
FT8MODEM_BASE_URL="${FT8MODEM_BASE_URL:-https://www.kk5jy.net/ft8modem/Software}"
WSJTX_UTILS_TARBALL="${WSJTX_UTILS_TARBALL:-wsjtx-utils-20260704.tar.gz}"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ENGINE_ARCH="x86_64"; WSJTX_ARCH="x86" ;;
  aarch64|arm64) ENGINE_ARCH="aarch64"; WSJTX_ARCH="aarch64" ;;
  *)
    echo "error: unsupported architecture '$ARCH' (supported: x86_64, aarch64)" >&2
    exit 1
    ;;
esac

BIN_DIR="$ROOT_DIR/vendor/engine/$ENGINE_ARCH/bin"
BUILD_DIR="$ROOT_DIR/vendor/engine/build"
CACHE_DIR="$ROOT_DIR/vendor/engine/cache"
MANIFEST_PATH="$ROOT_DIR/vendor/engine/manifest.json"

log() {
  printf 'install-engine: %s\n' "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command '$1' not found" >&2
    exit 1
  fi
}

install_apt_deps() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "apt-get not found; install build deps manually (gcc, cmake, libasound2-dev, libsndfile1-dev, hamlib-tools)"
    return
  fi

  log "installing apt build dependencies"
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential cmake pkg-config git curl ca-certificates \
    libasound2-dev libsndfile1-dev \
    hamlib-tools
}

fetch_tarball() {
  local name="$1"
  local dest="$2"
  if [[ -f "$dest" ]]; then
    return
  fi
  mkdir -p "$(dirname "$dest")"
  log "downloading $name"
  curl -fsSL "$FT8MODEM_BASE_URL/$name" -o "$dest"
}

build_ft8modem() {
  fetch_tarball "$FT8MODEM_TARBALL" "$CACHE_DIR/$FT8MODEM_TARBALL"
  rm -rf "$BUILD_DIR/ft8modem-src"
  mkdir -p "$BUILD_DIR"
  tar -xzf "$CACHE_DIR/$FT8MODEM_TARBALL" -C "$BUILD_DIR"
  local src_dir
  src_dir="$(find "$BUILD_DIR" -maxdepth 1 -type d -name 'ft8modem-*' | head -n1)"
  if [[ -z "$src_dir" ]]; then
    echo "error: could not locate ft8modem source directory after extract" >&2
    exit 1
  fi

  log "building ft8modem from $src_dir"
  cmake -S "$src_dir" -B "$BUILD_DIR/cmake-build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$BUILD_DIR/cmake-build" -j"$(nproc 2>/dev/null || echo 2)"

  mkdir -p "$BIN_DIR"
  install -m 755 "$BUILD_DIR/cmake-build/ft8modem" "$BIN_DIR/ft8modem"
  if [[ -f "$src_dir/ft8cat" ]]; then
    install -m 755 "$src_dir/ft8cat" "$BIN_DIR/ft8cat"
  elif [[ -f "$BUILD_DIR/cmake-build/ft8cat" ]]; then
    install -m 755 "$BUILD_DIR/cmake-build/ft8cat" "$BIN_DIR/ft8cat"
  else
    # KK5JY ships ft8cat as a script alongside sources.
    local ft8cat_src
    ft8cat_src="$(find "$src_dir" -maxdepth 2 -type f -name 'ft8cat' | head -n1)"
    if [[ -z "$ft8cat_src" ]]; then
      echo "error: ft8cat not found in ft8modem source tree" >&2
      exit 1
    fi
    install -m 755 "$ft8cat_src" "$BIN_DIR/ft8cat"
  fi
}

install_wsjtx_utils() {
  fetch_tarball "$WSJTX_UTILS_TARBALL" "$CACHE_DIR/$WSJTX_UTILS_TARBALL"
  rm -rf "$BUILD_DIR/wsjtx-utils"
  mkdir -p "$BUILD_DIR/wsjtx-utils"
  tar -xzf "$CACHE_DIR/$WSJTX_UTILS_TARBALL" -C "$BUILD_DIR/wsjtx-utils"

  local utils_dir
  utils_dir="$(find "$BUILD_DIR/wsjtx-utils" -maxdepth 2 -type d -name "$WSJTX_ARCH" | head -n1)"
  if [[ -z "$utils_dir" ]]; then
    echo "error: wsjtx-utils tarball missing '$WSJTX_ARCH' binaries" >&2
    exit 1
  fi

  mkdir -p "$BIN_DIR"
  for tool in jt9 ft8code ft4code; do
    if [[ ! -f "$utils_dir/$tool" ]]; then
      echo "error: wsjtx-utils missing $tool for $WSJTX_ARCH" >&2
      exit 1
    fi
    install -m 755 "$utils_dir/$tool" "$BIN_DIR/$tool"
  done
}

install_rigctld() {
  mkdir -p "$BIN_DIR"
  if command -v rigctld >/dev/null 2>&1; then
    local rigctld_path
    rigctld_path="$(command -v rigctld)"
    cp "$rigctld_path" "$BIN_DIR/rigctld"
    chmod 755 "$BIN_DIR/rigctld"
    return
  fi
  echo "error: rigctld not found; install hamlib-tools (apt) and re-run" >&2
  exit 1
}

write_manifest() {
  mkdir -p "$(dirname "$MANIFEST_PATH")"
  cat >"$MANIFEST_PATH" <<EOF
{
  "arch": "$ENGINE_ARCH",
  "version": "${FT8MODEM_VERSION:-unknown}",
  "bins": {
    "ft8cat": "vendor/engine/$ENGINE_ARCH/bin/ft8cat",
    "ft8modem": "vendor/engine/$ENGINE_ARCH/bin/ft8modem",
    "rigctld": "vendor/engine/$ENGINE_ARCH/bin/rigctld",
    "jt9": "vendor/engine/$ENGINE_ARCH/bin/jt9",
    "ft8code": "vendor/engine/$ENGINE_ARCH/bin/ft8code",
    "ft4code": "vendor/engine/$ENGINE_ARCH/bin/ft4code"
  }
}
EOF
}

verify_bins() {
  export PATH="$BIN_DIR:$PATH"
  for tool in ft8modem ft8cat rigctld jt9 ft8code ft4code; do
    local path="$BIN_DIR/$tool"
    if [[ ! -x "$path" ]]; then
      echo "error: missing executable $path" >&2
      exit 1
    fi
    file "$path" | grep -Eiq 'elf|script' || {
      echo "error: $path does not look executable on this architecture" >&2
      exit 1
    }
  done
  log "verified binaries in $BIN_DIR"
}

main() {
  require_cmd curl
  require_cmd cmake
  require_cmd tar
  require_cmd file

  install_apt_deps
  mkdir -p "$BIN_DIR" "$CACHE_DIR"
  build_ft8modem
  install_wsjtx_utils
  install_rigctld
  write_manifest
  verify_bins

  log "engine stack installed for $ENGINE_ARCH"
  log "manifest written to $MANIFEST_PATH"
  log "wsjtx-utils decode binaries are redistributed for private ham-lab use; see WSJT-X license"
}

main "$@"
