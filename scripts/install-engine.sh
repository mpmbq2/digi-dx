#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/scripts/engine-versions.env" ]]; then
  # shellcheck source=scripts/engine-versions.env
  source "$ROOT_DIR/scripts/engine-versions.env"
fi

FT8MODEM_VERSION="${FT8MODEM_VERSION:-1.0.11991}"
FT8MODEM_TARBALL="${FT8MODEM_TARBALL:-ft8modem-20260820-1.0.11991.tar.gz}"
FT8MODEM_BASE_URL="${FT8MODEM_BASE_URL:-https://www.kk5jy.net/ft8modem/Software}"
WSJTX_UTILS_X86_64_TARBALL="${WSJTX_UTILS_X86_64_TARBALL:-wsjtx-utils-2.6.1-x86_64-20260812.tar.xz}"
WSJTX_UTILS_AARCH64_TARBALL="${WSJTX_UTILS_AARCH64_TARBALL:-wsjtx-utils-2.6.1-aarch64-20260812.tar.xz}"
RTAUDIO_GIT_URL="${RTAUDIO_GIT_URL:-https://github.com/thestk/rtaudio.git}"
RTAUDIO_GIT_TAG="${RTAUDIO_GIT_TAG:-6.0.1}"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)
    ENGINE_ARCH="x86_64"
    WSJTX_UTILS_TARBALL="$WSJTX_UTILS_X86_64_TARBALL"
    ;;
  aarch64|arm64)
    ENGINE_ARCH="aarch64"
    WSJTX_UTILS_TARBALL="$WSJTX_UTILS_AARCH64_TARBALL"
    ;;
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

run_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command '$1' not found" >&2
    exit 1
  fi
}

install_apt_deps() {
  if ! command -v apt-get >/dev/null 2>&1; then
    log "apt-get not found; install build deps manually (gcc, cmake, make, git, libasound2-dev, libsndfile1-dev, libhamlib-utils, python3)"
    return
  fi

  local qt5_pkg="libqt5core5a"
  if apt-cache show libqt5core5t64 >/dev/null 2>&1; then
    qt5_pkg="libqt5core5t64"
  fi

  log "installing apt build and runtime dependencies"
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config git curl ca-certificates xz-utils file python3 \
    libasound2-dev libsndfile1-dev libfftw3-single3 "$qt5_pkg" libgfortran5 libgomp1 \
    libhamlib-utils
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

build_rtaudio() {
  if [[ -e /usr/local/lib/librtaudio.so.8 || -e /usr/local/lib/librtaudio.so ]]; then
    log "rtaudio already installed in /usr/local/lib"
    return
  fi

  log "building rtaudio $RTAUDIO_GIT_TAG from $RTAUDIO_GIT_URL"
  rm -rf "$BUILD_DIR/rtaudio-src" "$BUILD_DIR/rtaudio-build"
  git clone --depth 1 --branch "$RTAUDIO_GIT_TAG" "$RTAUDIO_GIT_URL" "$BUILD_DIR/rtaudio-src"
  cmake -S "$BUILD_DIR/rtaudio-src" -B "$BUILD_DIR/rtaudio-build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DRTAUDIO_API_ALSA=ON \
    -DRTAUDIO_API_PULSE=OFF \
    -DRTAUDIO_API_JACK=OFF
  cmake --build "$BUILD_DIR/rtaudio-build" -j"$(nproc 2>/dev/null || echo 2)"
  run_root cmake --install "$BUILD_DIR/rtaudio-build"
  run_root ldconfig
}

build_ft8modem() {
  fetch_tarball "$FT8MODEM_TARBALL" "$CACHE_DIR/$FT8MODEM_TARBALL"
  rm -rf "$BUILD_DIR/ft8modem-"*
  mkdir -p "$BUILD_DIR"
  tar -xzf "$CACHE_DIR/$FT8MODEM_TARBALL" -C "$BUILD_DIR"
  local src_dir
  src_dir="$(find "$BUILD_DIR" -maxdepth 1 -type d -name 'ft8modem-*' | head -n1)"
  if [[ -z "$src_dir" ]]; then
    echo "error: could not locate ft8modem source directory after extract" >&2
    exit 1
  fi

  log "building ft8modem from $src_dir"
  make -C "$src_dir" -j"$(nproc 2>/dev/null || echo 2)"
  run_root make -C "$src_dir" install
  run_root ldconfig

  mkdir -p "$BIN_DIR"
  install -m 755 /usr/local/bin/ft8modem "$BIN_DIR/ft8modem"
  cat >"$BIN_DIR/ft8cat" <<'EOF'
#!/usr/bin/env bash
exec python3 -B /usr/local/lib/ft8modem/ft8cat "$@"
EOF
  chmod 755 "$BIN_DIR/ft8cat"
}

install_wsjtx_utils() {
  fetch_tarball "$WSJTX_UTILS_TARBALL" "$CACHE_DIR/$WSJTX_UTILS_TARBALL"
  rm -rf "$BUILD_DIR/wsjtx-utils"
  mkdir -p "$BUILD_DIR/wsjtx-utils"
  tar -xJf "$CACHE_DIR/$WSJTX_UTILS_TARBALL" -C "$BUILD_DIR/wsjtx-utils"

  mkdir -p "$BIN_DIR"
  for tool in jt9 ft8code ft4code; do
    local src_tool
    src_tool="$(find "$BUILD_DIR/wsjtx-utils" -maxdepth 3 -type f -name "$tool" | head -n1)"
    if [[ -z "$src_tool" ]]; then
      echo "error: wsjtx-utils missing $tool for $ENGINE_ARCH" >&2
      exit 1
    fi
    run_root install -m 755 "$src_tool" "/usr/local/bin/$tool"
    install -m 755 "$src_tool" "$BIN_DIR/$tool"
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
  echo "error: rigctld not found; install libhamlib-utils (apt) and re-run" >&2
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
  install_apt_deps
  require_cmd curl
  require_cmd cmake
  require_cmd make
  require_cmd git
  require_cmd tar
  require_cmd xz
  require_cmd file
  require_cmd python3

  mkdir -p "$BIN_DIR" "$CACHE_DIR"
  build_rtaudio
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
