#!/usr/bin/env bash
set -euo pipefail

# Digi-Dx v2 Cross-Platform Bootstrap & Service Installer
# Supports Linux (apt, dnf, pacman + systemd) and macOS (Homebrew + launchd).

REPO="${DIGI_DX_REPO:-mpmbq2/digi-dx}"
BINARY_PATH="/usr/local/bin/digi-dx"
UDEV_RULES_PATH="/etc/udev/rules.d/99-digi-dx.rules"
SYSTEMD_UNIT_PATH="/etc/systemd/system/digi-dx.service"
ENV_DIR="/etc/digi-dx"
ENV_FILE="/etc/digi-dx/digi-dx.env"
LINUX_DATA_DIR="/var/lib/digi-dx"

AUTO_YES=0
TARGET_VERSION="latest"
FROM_SOURCE=0
NO_JT9=0
NO_SERVICE=0
CUSTOM_USER=""
DRY_RUN=0
UNINSTALL=0

OS_NAME=""
ARCH_NORM=""
PKG_MGR=""
SERVICE_USER=""
INTERACTIVE_USER=""
GROUPS_MODIFIED=0

log_info() {
  printf '[digi-dx] %s\n' "$*"
}

log_warn() {
  printf '[digi-dx] WARN: %s\n' "$*" >&2
}

log_err() {
  printf '[digi-dx] ERROR: %s\n' "$*" >&2
}

die() {
  log_err "$*"
  exit 1
}

usage() {
  cat <<'EOF'
Digi-Dx v2 Installer

Usage:
  scripts/install.sh [options]

Options:
  -y, --yes              Non-interactive mode; accept package manager prompts
      --version <tag>    Pin a specific release tag (default: latest)
      --from-source      Build UI (npm) and Rust binary locally via cargo
      --no-jt9           Skip installing wsjtx/jt9 (use built-in ft8_lib fallback)
      --no-service       Install binary/deps/udev without systemd or launchd service
      --user <name>      Service user on Linux (default: digi-dx, or current user with --no-service)
      --dry-run          Print planned actions without modifying the system
      --uninstall        Stop/disable service, remove binary & udev rules (preserves QSO DBs)
  -h, --help             Show this help message
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -y|--yes)
        AUTO_YES=1
        shift
        ;;
      --version)
        [[ $# -ge 2 ]] || die "--version requires an argument"
        TARGET_VERSION="$2"
        shift 2
        ;;
      --from-source)
        FROM_SOURCE=1
        shift
        ;;
      --no-jt9)
        NO_JT9=1
        shift
        ;;
      --no-service)
        NO_SERVICE=1
        shift
        ;;
      --user)
        [[ $# -ge 2 ]] || die "--user requires an argument"
        CUSTOM_USER="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --uninstall)
        UNINSTALL=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown option: $1 (try --help)"
        ;;
    esac
  done
}

run_cmd() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

run_sudo() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    run_cmd "$@"
  else
    run_cmd sudo "$@"
  fi
}

write_privileged_content() {
  local dest="$1"
  local mode="$2"
  local content="$3"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '[dry-run] install file %s (mode %s)\n' "$dest" "$mode"
    return 0
  fi
  local tmp_file
  tmp_file="$(mktemp)"
  printf '%s\n' "$content" > "$tmp_file"
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    install -m "$mode" "$tmp_file" "$dest"
  else
    sudo install -m "$mode" "$tmp_file" "$dest"
  fi
  rm -f "$tmp_file"
}

resolve_repo_root() {
  local script_path="${BASH_SOURCE[0]:-}"
  if [[ -n "$script_path" && -f "$script_path" ]]; then
    local script_dir
    script_dir="$(cd "$(dirname "$script_path")" && pwd)"
    local candidate
    candidate="$(cd "$script_dir/.." && pwd)"
    if [[ -f "$candidate/Cargo.toml" || -d "$candidate/deploy" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  if [[ -f "$PWD/Cargo.toml" && -d "$PWD/ui" ]]; then
    printf '%s\n' "$PWD"
    return 0
  fi
  printf '\n'
}

detect_platform() {
  local raw_os
  local raw_arch
  raw_os="$(uname -s)"
  raw_arch="$(uname -m)"

  case "$raw_os" in
    Linux)
      OS_NAME="linux"
      ;;
    Darwin)
      OS_NAME="darwin"
      ;;
    *)
      die "Unsupported operating system: $raw_os (supported: Linux, macOS)"
      ;;
  esac

  case "$raw_arch" in
    x86_64|amd64)
      ARCH_NORM="x86_64"
      ;;
    aarch64|arm64)
      ARCH_NORM="aarch64"
      ;;
    armv7*|armhf|i386|i686)
      die "Unsupported CPU architecture: $raw_arch (v2.0 supports 64-bit x86_64 and aarch64/arm64 only)"
      ;;
    *)
      die "Unsupported CPU architecture: $raw_arch"
      ;;
  esac

  if [[ "$OS_NAME" == "linux" ]]; then
    if [[ -r /etc/os-release ]]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      log_info "Detected Linux distro: ${PRETTY_NAME:-${ID:-unknown}} ($ARCH_NORM)"
    else
      log_info "Detected Linux ($ARCH_NORM)"
    fi

    if command -v apt-get >/dev/null 2>&1; then
      PKG_MGR="apt"
    elif command -v dnf >/dev/null 2>&1; then
      PKG_MGR="dnf"
    elif command -v pacman >/dev/null 2>&1; then
      PKG_MGR="pacman"
    else
      die "No supported Linux package manager found (expected apt-get, dnf, or pacman)"
    fi
  else
    log_info "Detected macOS ($ARCH_NORM)"
    if ! command -v brew >/dev/null 2>&1; then
      die "Homebrew is required on macOS. Install from https://brew.sh and re-run."
    fi
    PKG_MGR="brew"
  fi

  local fallback_user
  fallback_user="${SUDO_USER:-${USER:-$(id -un)}}"
  INTERACTIVE_USER="$fallback_user"

  if [[ -n "$CUSTOM_USER" ]]; then
    SERVICE_USER="$CUSTOM_USER"
  elif [[ "$OS_NAME" == "linux" && $NO_SERVICE -eq 0 ]]; then
    SERVICE_USER="digi-dx"
  else
    SERVICE_USER="$fallback_user"
  fi
}

install_dependencies() {
  log_info "Step 2/7: Installing runtime dependencies via $PKG_MGR..."
  case "$PKG_MGR" in
    apt)
      local -a pkgs=(libhamlib-utils usbutils alsa-utils curl ca-certificates)
      if [[ $NO_JT9 -eq 0 ]]; then
        pkgs+=(wsjtx)
      fi
      if [[ $AUTO_YES -eq 1 ]]; then
        run_sudo env DEBIAN_FRONTEND=noninteractive apt-get update
        run_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "${pkgs[@]}"
      else
        run_sudo apt-get update
        run_sudo apt-get install -y "${pkgs[@]}"
      fi
      ;;
    dnf)
      local -a pkgs=(hamlib usbutils alsa-utils curl)
      if [[ $NO_JT9 -eq 0 ]]; then
        pkgs+=(wsjtx)
      fi
      local -a flags=()
      if [[ $AUTO_YES -eq 1 ]]; then
        flags=(-y)
      fi
      run_sudo dnf install "${flags[@]}" "${pkgs[@]}"
      ;;
    pacman)
      local -a pkgs=(hamlib usbutils alsa-utils curl)
      local -a flags=(--needed)
      if [[ $AUTO_YES -eq 1 ]]; then
        flags+=(--noconfirm)
      fi
      run_sudo pacman -S "${flags[@]}" "${pkgs[@]}"
      if [[ $NO_JT9 -eq 0 ]]; then
        if pacman -Si wsjtx >/dev/null 2>&1; then
          run_sudo pacman -S "${flags[@]}" wsjtx
        else
          log_warn "wsjtx not found in enabled pacman repos; install from AUR or rely on built-in ft8_lib fallback"
        fi
      fi
      ;;
    brew)
      run_cmd brew install hamlib
      if [[ $NO_JT9 -eq 0 ]]; then
        if ! brew list --cask wsjtx >/dev/null 2>&1; then
          run_cmd brew install --cask wsjtx || log_warn "wsjtx cask install failed; Digi-Dx will use built-in ft8_lib fallback"
        fi
      fi
      ;;
  esac

  verify_hamlib
  verify_jt9_if_present
}

verify_hamlib() {
  if ! command -v rigctl >/dev/null 2>&1 || ! command -v rigctld >/dev/null 2>&1; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log_info "[dry-run] Would verify rigctl --version and rigctld --version after package installation"
      return 0
    fi
    die "rigctl / rigctld not found on PATH after dependency installation"
  fi

  local rigctl_ver
  local rigctld_ver
  rigctl_ver="$(rigctl --version 2>&1 | head -n 1 || true)"
  rigctld_ver="$(rigctld --version 2>&1 | head -n 1 || true)"
  log_info "Verified: $rigctl_ver"
  log_info "Verified: $rigctld_ver"

  local parsed_ver=""
  if [[ "$rigctld_ver" =~ Hamlib[[:space:]]+([0-9]+)\.([0-9]+) ]]; then
    local major="${BASH_REMATCH[1]}"
    local minor="${BASH_REMATCH[2]}"
    parsed_ver="${major}.${minor}"
    if (( major < 4 || (major == 4 && minor < 5) )); then
      log_warn "Hamlib $parsed_ver is older than 4.5; upgrading is recommended for full '+' extended CAT support."
    fi
  fi
}

find_jt9_path() {
  if [[ -n "${DIGI_DX_JT9_PATH:-}" && -x "${DIGI_DX_JT9_PATH}" ]]; then
    printf '%s\n' "${DIGI_DX_JT9_PATH}"
    return 0
  fi
  if command -v jt9 >/dev/null 2>&1; then
    command -v jt9
    return 0
  fi
  local candidate
  for candidate in /usr/local/lib/digi-dx/jt9 /Applications/wsjtx.app/Contents/MacOS/jt9; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

verify_jt9_if_present() {
  if [[ $NO_JT9 -eq 1 ]]; then
    log_info "Skipping jt9 check (--no-jt9); built-in ft8_lib fallback will be used."
    return 0
  fi
  local jt9_bin=""
  if jt9_bin="$(find_jt9_path)"; then
    if command -v file >/dev/null 2>&1; then
      local file_desc
      file_desc="$(file -b "$jt9_bin" || true)"
      log_info "Found jt9 at $jt9_bin ($file_desc)"
    else
      log_info "Found jt9 at $jt9_bin"
    fi
    if "$jt9_bin" -h >/dev/null 2>&1; then
      log_info "jt9 execution probe passed"
    else
      log_warn "jt9 at $jt9_bin failed execution probe (wrong arch or missing shared libs); built-in ft8_lib fallback will activate"
    fi
  else
    log_warn "jt9 binary not found; Digi-Dx will use built-in ft8_lib fallback decoder"
  fi
}

provision_binary() {
  log_info "Step 3/7: Provisioning digi-dx binary..."
  local repo_root
  repo_root="$(resolve_repo_root)"

  if [[ $FROM_SOURCE -eq 1 ]]; then
    [[ -n "$repo_root" && -f "$repo_root/Cargo.toml" ]] || die "--from-source must be run inside a Digi-Dx git checkout"
    if [[ $DRY_RUN -eq 1 ]]; then
      log_info "[dry-run] Would build frontend SPA in $repo_root/ui via npm ci/install && npm run build"
      log_info "[dry-run] Would compile release binary via cargo build --release in $repo_root"
      run_sudo install -m 0755 "$repo_root/target/release/digi-dx" "$BINARY_PATH"
      return 0
    fi

    command -v npm >/dev/null 2>&1 || die "npm is required for --from-source"
    if ! command -v cargo >/dev/null 2>&1; then
      if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
        export PATH="$HOME/.cargo/bin:$PATH"
      else
        die "cargo (Rust >= 1.82) is required for --from-source"
      fi
    fi

    (
      cd "$repo_root/ui"
      if [[ -f package-lock.json ]]; then
        npm ci
      else
        npm install
      fi
      npm run build
    )
    (
      cd "$repo_root"
      cargo build --release
    )
    run_sudo install -m 0755 "$repo_root/target/release/digi-dx" "$BINARY_PATH"
    return 0
  fi

  local ver_tag="$TARGET_VERSION"
  local base_url
  if [[ "$ver_tag" == "latest" ]]; then
    base_url="https://github.com/${REPO}/releases/latest/download"
  else
    base_url="https://github.com/${REPO}/releases/download/${ver_tag}"
  fi

  local tarball="digi-dx-${ver_tag}-${OS_NAME}-${ARCH_NORM}.tar.gz"
  local tarball_url="${base_url}/${tarball}"
  local sums_url="${base_url}/SHA256SUMS"

  if [[ $DRY_RUN -eq 1 ]]; then
    log_info "[dry-run] Would download $tarball_url and $sums_url"
    log_info "[dry-run] Would verify SHA-256 checksum and install binary to $BINARY_PATH (0755)"
    return 0
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' RETURN

  curl -fsSL "$tarball_url" -o "$tmp_dir/$tarball"
  curl -fsSL "$sums_url" -o "$tmp_dir/SHA256SUMS"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$tmp_dir" && grep "  $tarball\$" SHA256SUMS | sha256sum -c -)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$tmp_dir" && grep "  $tarball\$" SHA256SUMS | shasum -a 256 -c -)
  else
    die "Neither sha256sum nor shasum found to verify release checksum"
  fi

  tar -xzf "$tmp_dir/$tarball" -C "$tmp_dir"
  [[ -f "$tmp_dir/digi-dx" ]] || die "Archive $tarball did not contain digi-dx executable"
  run_sudo install -m 0755 "$tmp_dir/digi-dx" "$BINARY_PATH"
}

udev_rules_content() {
  local repo_root
  repo_root="$(resolve_repo_root)"
  if [[ -n "$repo_root" && -f "$repo_root/deploy/udev/99-digi-dx.rules" ]]; then
    cat "$repo_root/deploy/udev/99-digi-dx.rules"
    return 0
  fi
  cat <<'EOF'
# Digi-Dx v2 — Amateur Radio USB-Serial CAT & USB Audio Device Permissions
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60|ea70|ea71", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="2303|23a3|23c3", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523|5523|55d4", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"
SUBSYSTEM=="tty", ATTRS{idVendor}=="04d8|0483|2e8a", MODE="0660", GROUP="dialout", TAG+="uaccess", ENV{DIGI_DX_CAT_CANDIDATE}="1"
SUBSYSTEM=="sound", ATTRS{idVendor}=="08bb", MODE="0660", GROUP="audio", TAG+="uaccess", ENV{DIGI_DX_AUDIO_CANDIDATE}="1"
SUBSYSTEM=="sound", ATTRS{idVendor}=="0d8c", MODE="0660", GROUP="audio", TAG+="uaccess", ENV{DIGI_DX_AUDIO_CANDIDATE}="1"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0d8c", MODE="0660", GROUP="plugdev", TAG+="uaccess"
EOF
}

ensure_user_groups() {
  local target_user="$1"
  local grp
  for grp in dialout plugdev audio; do
    if ! id -nG "$target_user" 2>/dev/null | tr ' ' '\n' | grep -qx "$grp"; then
      GROUPS_MODIFIED=1
      break
    fi
  done
  run_sudo usermod -aG dialout,plugdev,audio "$target_user"
}

setup_linux_udev_and_groups() {
  if [[ "$OS_NAME" != "linux" ]]; then
    log_info "Step 4/7: Skipping Linux udev/group setup on macOS (CoreAudio/IOKit native)"
    return 0
  fi

  log_info "Step 4/7: Installing udev rules and configuring serial/audio groups..."
  local rules_body
  rules_body="$(udev_rules_content)"
  write_privileged_content "$UDEV_RULES_PATH" "0644" "$rules_body"

  if command -v udevadm >/dev/null 2>&1; then
    run_sudo udevadm control --reload-rules
    run_sudo udevadm trigger --subsystem-match=tty --subsystem-match=sound
  fi

  if ! getent group plugdev >/dev/null 2>&1; then
    run_sudo groupadd --system plugdev
  fi

  if [[ "$SERVICE_USER" == "digi-dx" ]] && ! id -u digi-dx >/dev/null 2>&1; then
    run_sudo useradd --system --home-dir "$LINUX_DATA_DIR" --shell /usr/sbin/nologin digi-dx
  fi

  if [[ -n "$SERVICE_USER" ]]; then
    ensure_user_groups "$SERVICE_USER"
  fi
  if [[ -n "$INTERACTIVE_USER" && "$INTERACTIVE_USER" != "root" && "$INTERACTIVE_USER" != "$SERVICE_USER" ]]; then
    ensure_user_groups "$INTERACTIVE_USER"
  fi

  if [[ $GROUPS_MODIFIED -eq 1 ]]; then
    log_warn "Group membership changed for $INTERACTIVE_USER (dialout/plugdev/audio)."
    log_warn "Start a fresh SSH login (and run 'tmux kill-server' if inside tmux) so interactive shells inherit the new groups."
    log_warn "Note: the systemd service receives SupplementaryGroups=dialout plugdev audio immediately upon start."
  fi
}

env_file_content() {
  cat <<'EOF'
# Digi-Dx v2 Daemon Environment Configuration
DIGI_DX_BIND=0.0.0.0
DIGI_DX_PORT=8788
DIGI_DX_DATA_DIR=/var/lib/digi-dx
DIGI_DX_GCP_TELEMETRY_ENABLED=false
DIGI_DX_GCP_BRIDGE_ENABLED=false
RUST_LOG=info,digi_dx=info
EOF
}

setup_data_dirs() {
  log_info "Step 5/7: Setting up data directories and permissions..."
  if [[ "$OS_NAME" == "linux" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      log_info "[dry-run] install -d -o $SERVICE_USER -g $SERVICE_USER -m 0750 $LINUX_DATA_DIR"
      log_info "[dry-run] install -d -m 0755 $ENV_DIR"
    else
      local svc_group="$SERVICE_USER"
      if id -gn "$SERVICE_USER" >/dev/null 2>&1; then
        svc_group="$(id -gn "$SERVICE_USER")"
      fi
      run_sudo install -d -o "$SERVICE_USER" -g "$svc_group" -m 0750 "$LINUX_DATA_DIR"
      run_sudo install -d -m 0755 "$ENV_DIR"
    fi

    if [[ ! -f "$ENV_FILE" ]]; then
      local env_body
      env_body="$(env_file_content)"
      write_privileged_content "$ENV_FILE" "0600" "$env_body"
    else
      log_info "Preserving existing $ENV_FILE"
    fi
  else
    local mac_data="$HOME/Library/Application Support/digi-dx"
    local mac_logs="$HOME/Library/Logs/digi-dx"
    run_cmd mkdir -p "$mac_data" "$mac_logs"
    run_cmd chmod 0700 "$mac_data" "$mac_logs"
  fi
}

systemd_unit_content() {
  local svc_group="$SERVICE_USER"
  if [[ $DRY_RUN -eq 0 ]] && id -gn "$SERVICE_USER" >/dev/null 2>&1; then
    svc_group="$(id -gn "$SERVICE_USER")"
  fi
  cat <<EOF
[Unit]
Description=Digi-Dx v2 Local FT8 & Transceiver Daemon
Documentation=https://github.com/${REPO}
After=network-online.target sound.target time-sync.target
Wants=network-online.target time-sync.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${svc_group}
SupplementaryGroups=dialout plugdev audio
EnvironmentFile=-${ENV_FILE}
Environment=DIGI_DX_BIND=0.0.0.0
Environment=DIGI_DX_PORT=8788
Environment=DIGI_DX_DATA_DIR=${LINUX_DATA_DIR}
Environment=RUST_LOG=info,digi_dx=info
ExecStartPre=${BINARY_PATH} preflight --fail-on-fatal
ExecStart=${BINARY_PATH} serve
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
KillMode=mixed

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=false
ReadWritePaths=${LINUX_DATA_DIR} /tmp
DevicePolicy=auto

[Install]
WantedBy=multi-user.target
EOF
}

launchd_plist_content() {
  local repo_root
  repo_root="$(resolve_repo_root)"
  local current_user="${USER:-$(id -un)}"
  if [[ -n "$repo_root" && -f "$repo_root/deploy/launchd/com.digidx.daemon.plist" ]]; then
    sed "s/REPLACE_USER/${current_user}/g" "$repo_root/deploy/launchd/com.digidx.daemon.plist"
    return 0
  fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.digidx.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BINARY_PATH}</string>
        <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DIGI_DX_BIND</key>
        <string>0.0.0.0</string>
        <key>DIGI_DX_PORT</key>
        <string>8788</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>RUST_LOG</key>
        <string>info</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/digi-dx/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/digi-dx/stderr.log</string>
</dict>
</plist>
EOF
}

setup_service() {
  if [[ $NO_SERVICE -eq 1 ]]; then
    log_info "Step 6/7: Skipping native service registration (--no-service)"
    return 0
  fi

  log_info "Step 6/7: Registering and starting native service..."
  if [[ "$OS_NAME" == "linux" ]]; then
    local unit_body
    unit_body="$(systemd_unit_content)"
    write_privileged_content "$SYSTEMD_UNIT_PATH" "0644" "$unit_body"
    run_sudo systemctl daemon-reload
    run_sudo systemctl enable --now digi-dx.service
  else
    local launch_dir="$HOME/Library/LaunchAgents"
    local plist_path="$launch_dir/com.digidx.daemon.plist"
    local gui_domain
    gui_domain="gui/$(id -u)"
    run_cmd mkdir -p "$launch_dir"
    if [[ $DRY_RUN -eq 1 ]]; then
      log_info "[dry-run] write $plist_path"
    else
      launchd_plist_content > "$plist_path"
    fi
    run_cmd launchctl bootout "${gui_domain}/com.digidx.daemon" || true
    run_cmd launchctl bootstrap "$gui_domain" "$plist_path"
  fi
}

verify_installation() {
  log_info "Step 7/7: Running post-install verification..."
  if [[ $DRY_RUN -eq 1 ]]; then
    if [[ "$OS_NAME" == "linux" && $NO_SERVICE -eq 0 ]]; then
      log_info "[dry-run] Would run: sudo -u $SERVICE_USER $BINARY_PATH preflight --data-dir $LINUX_DATA_DIR"
    else
      log_info "[dry-run] Would run: $BINARY_PATH preflight"
    fi
    if [[ $NO_SERVICE -eq 0 ]]; then
      log_info "[dry-run] Would probe http://127.0.0.1:8788/api/v1/health"
    fi
    log_info "[dry-run] Install plan complete."
    return 0
  fi

  if [[ "$OS_NAME" == "linux" && $NO_SERVICE -eq 0 ]]; then
    run_sudo -u "$SERVICE_USER" "$BINARY_PATH" preflight --data-dir "$LINUX_DATA_DIR"
  else
    "$BINARY_PATH" preflight
  fi

  if [[ $NO_SERVICE -eq 0 ]]; then
    local ok=0
    local i
    for i in 1 2 3 4 5; do
      if curl -fsS http://127.0.0.1:8788/api/v1/health >/dev/null 2>&1; then
        ok=1
        break
      fi
      sleep 1
    done
    if [[ $ok -eq 1 ]]; then
      local host_ip="127.0.0.1"
      if [[ "$OS_NAME" == "linux" ]] && command -v hostname >/dev/null 2>&1; then
        host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || printf '127.0.0.1')"
      fi
      log_info "Digi-Dx daemon is live at http://${host_ip}:8788"
    else
      log_warn "Service started, but http://127.0.0.1:8788/api/v1/health did not respond within 5s. Check service logs."
    fi
  fi
}

do_uninstall() {
  log_info "Uninstalling Digi-Dx v2 (preserving QSO databases)..."
  if [[ "$OS_NAME" == "linux" ]]; then
    if command -v systemctl >/dev/null 2>&1; then
      run_sudo systemctl disable --now digi-dx.service || true
    fi
    run_sudo rm -f "$SYSTEMD_UNIT_PATH"
    if command -v systemctl >/dev/null 2>&1; then
      run_sudo systemctl daemon-reload || true
    fi
    run_sudo rm -f "$UDEV_RULES_PATH"
    if command -v udevadm >/dev/null 2>&1; then
      run_sudo udevadm control --reload-rules || true
      run_sudo udevadm trigger --subsystem-match=tty --subsystem-match=sound || true
    fi
    run_sudo rm -f "$BINARY_PATH"
    log_info "Preserved state directory: $LINUX_DATA_DIR and config: $ENV_DIR"
  else
    local plist_path="$HOME/Library/LaunchAgents/com.digidx.daemon.plist"
    local gui_domain
    gui_domain="gui/$(id -u)"
    run_cmd launchctl bootout "${gui_domain}/com.digidx.daemon" || true
    run_cmd rm -f "$plist_path"
    run_sudo rm -f "$BINARY_PATH"
    log_info "Preserved state directory: $HOME/Library/Application Support/digi-dx"
  fi
  log_info "Uninstall complete."
}

main() {
  parse_args "$@"
  detect_platform

  if [[ $UNINSTALL -eq 1 ]]; then
    do_uninstall
    exit 0
  fi

  log_info "Step 1/7: Platform=$OS_NAME Arch=$ARCH_NORM PkgMgr=$PKG_MGR ServiceUser=$SERVICE_USER"
  install_dependencies
  provision_binary
  setup_linux_udev_and_groups
  setup_data_dirs
  setup_service
  verify_installation
}

main "$@"
