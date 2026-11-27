use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::Utc;
use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};

use crate::config::DaemonConfig;
use crate::store::{format_utc, StateStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverallStatus {
    Ok,
    OkWithWarnings,
    Fatal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckSeverity {
    Fatal,
    Warn,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformInfo {
    pub os: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightCheck {
    pub id: String,
    pub status: CheckStatus,
    pub severity: CheckSeverity,
    pub detail: String,
    pub remediation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreflightReport {
    pub overall_status: OverallStatus,
    pub checked_at_utc: String,
    pub platform: PlatformInfo,
    pub active_ft8_decoder: String,
    pub checks: Vec<PreflightCheck>,
}

impl PreflightReport {
    pub fn has_fatal(&self) -> bool {
        self.overall_status == OverallStatus::Fatal
    }
}

pub const RIGCTL_FALLBACK_PATHS: &[&str] = &["/opt/homebrew/bin/rigctl", "/usr/local/bin/rigctl"];
pub const RIGCTLD_FALLBACK_PATHS: &[&str] =
    &["/opt/homebrew/bin/rigctld", "/usr/local/bin/rigctld"];

pub fn run_preflight(cfg: &DaemonConfig, probe_audio: bool) -> PreflightReport {
    let mut checks = Vec::new();

    let rigctl_res = check_binary_version(
        "hamlib_rigctl",
        "rigctl",
        cfg.rigctl_path.as_deref(),
        RIGCTL_FALLBACK_PATHS,
        &["--version"],
        "Install libhamlib-utils (apt) / hamlib (dnf/pacman/brew).",
    );
    let rigctld_res = check_binary_version(
        "hamlib_rigctld",
        "rigctld",
        cfg.rigctld_path.as_deref(),
        RIGCTLD_FALLBACK_PATHS,
        &["--version"],
        "Install libhamlib-utils (apt) / hamlib (dnf/pacman/brew).",
    );

    let version_source = rigctld_res
        .version_line
        .as_deref()
        .or(rigctl_res.version_line.as_deref());
    let hamlib_ver_check = evaluate_hamlib_version(version_source);

    checks.push(rigctl_res.check);
    checks.push(rigctld_res.check);
    checks.push(hamlib_ver_check);
    checks.push(check_usb_utils());

    #[cfg(target_os = "linux")]
    {
        checks.push(check_udev_rules(Path::new(
            "/etc/udev/rules.d/99-digi-dx.rules",
        )));
        checks.push(check_os_groups_live());
    }

    checks.push(check_audio_backend(probe_audio));

    let ftxr_check = check_ftxr_decoder(cfg.ftxr_path.as_deref());
    let active_ft8_decoder = if ftxr_check.status == CheckStatus::Pass {
        checks.push(ftxr_check);
        "ftxr".to_string()
    } else {
        let jt9_check = check_jt9_decoder(cfg.jt9_path.as_deref());
        if jt9_check.status == CheckStatus::Pass {
            checks.push(PreflightCheck {
                id: ftxr_check.id,
                status: CheckStatus::Info,
                severity: CheckSeverity::Info,
                detail: format!("{} (using legacy jt9 fallback)", ftxr_check.detail),
                remediation: ftxr_check.remediation,
            });
            checks.push(jt9_check);
            "jt9".to_string()
        } else {
            checks.push(ftxr_check);
            "ft8_lib_fallback".to_string()
        }
    };

    checks.push(check_sqlite_storage(&cfg.data_dir));
    checks.push(check_system_clock_sync());

    let overall_status = if checks
        .iter()
        .any(|c| c.severity == CheckSeverity::Fatal && c.status == CheckStatus::Fail)
    {
        OverallStatus::Fatal
    } else if checks
        .iter()
        .any(|c| matches!(c.status, CheckStatus::Warn | CheckStatus::Fail))
    {
        OverallStatus::OkWithWarnings
    } else {
        OverallStatus::Ok
    };

    PreflightReport {
        overall_status,
        checked_at_utc: format_utc(Utc::now()),
        platform: PlatformInfo {
            os: env::consts::OS.to_string(),
            arch: env::consts::ARCH.to_string(),
        },
        active_ft8_decoder,
        checks,
    }
}

struct BinaryProbe {
    check: PreflightCheck,
    version_line: Option<String>,
}

fn check_binary_version(
    id: &str,
    bin_name: &str,
    override_path: Option<&Path>,
    extra_candidates: &[&str],
    args: &[&str],
    remediation: &str,
) -> BinaryProbe {
    let resolved = resolve_executable(bin_name, override_path, extra_candidates);
    let Some(path) = resolved else {
        return BinaryProbe {
            check: PreflightCheck {
                id: id.to_string(),
                status: CheckStatus::Fail,
                severity: CheckSeverity::Fatal,
                detail: format!("{bin_name} not found on PATH or configured override"),
                remediation: Some(remediation.to_string()),
            },
            version_line: None,
        };
    };

    match Command::new(&path).args(args).output() {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            let first = text
                .lines()
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(bin_name)
                .to_string();
            BinaryProbe {
                check: PreflightCheck {
                    id: id.to_string(),
                    status: CheckStatus::Pass,
                    severity: CheckSeverity::Fatal,
                    detail: format!("{first} at {}", path.display()),
                    remediation: None,
                },
                version_line: Some(first),
            }
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            BinaryProbe {
                check: PreflightCheck {
                    id: id.to_string(),
                    status: CheckStatus::Fail,
                    severity: CheckSeverity::Fatal,
                    detail: format!("{} exited with {}: {}", path.display(), out.status, err),
                    remediation: Some(remediation.to_string()),
                },
                version_line: None,
            }
        }
        Err(e) => BinaryProbe {
            check: PreflightCheck {
                id: id.to_string(),
                status: CheckStatus::Fail,
                severity: CheckSeverity::Fatal,
                detail: format!("Failed to execute {}: {e}", path.display()),
                remediation: Some(remediation.to_string()),
            },
            version_line: None,
        },
    }
}

pub fn parse_hamlib_version(version_line: &str) -> Option<(u32, u32, Option<u32>)> {
    let idx = version_line.find("Hamlib")?;
    let rest = version_line[idx + "Hamlib".len()..].trim_start();
    let token = rest.split_whitespace().next()?;
    let mut parts = token.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor_raw = parts.next()?;
    let minor_digits: String = minor_raw
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let minor: u32 = minor_digits.parse().ok()?;
    let patch = parts.next().and_then(|p| {
        let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            None
        } else {
            digits.parse::<u32>().ok()
        }
    });
    Some((major, minor, patch))
}

pub fn evaluate_hamlib_version(version_line: Option<&str>) -> PreflightCheck {
    let Some(line) = version_line else {
        return PreflightCheck {
            id: "hamlib_version".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: "Unable to check Hamlib version because rigctld/rigctl did not run".to_string(),
            remediation: Some("Install Hamlib >= 4.5 (libhamlib-utils / hamlib).".to_string()),
        };
    };

    match parse_hamlib_version(line) {
        Some((maj, min, patch)) => {
            let ver_str = match patch {
                Some(p) => format!("{maj}.{min}.{p}"),
                None => format!("{maj}.{min}"),
            };
            if maj > 4 || (maj == 4 && min >= 5) {
                PreflightCheck {
                    id: "hamlib_version".to_string(),
                    status: CheckStatus::Pass,
                    severity: CheckSeverity::Warn,
                    detail: format!("Hamlib {ver_str} (>= 4.5 required)"),
                    remediation: None,
                }
            } else {
                PreflightCheck {
                    id: "hamlib_version".to_string(),
                    status: CheckStatus::Warn,
                    severity: CheckSeverity::Warn,
                    detail: format!(
                        "Hamlib {ver_str} is older than 4.5 (known CAT & '+' protocol quirks)"
                    ),
                    remediation: Some(
                        "Upgrade Hamlib to >= 4.5 via distro backports or Homebrew.".to_string(),
                    ),
                }
            }
        }
        None => PreflightCheck {
            id: "hamlib_version".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: format!("Could not parse Hamlib version from '{line}'"),
            remediation: Some("Ensure Hamlib >= 4.5 is installed.".to_string()),
        },
    }
}

fn check_usb_utils() -> PreflightCheck {
    #[cfg(target_os = "macos")]
    {
        if let Some(p) = resolve_executable("ioreg", None, &["/usr/sbin/ioreg"]) {
            PreflightCheck {
                id: "usb_utils".to_string(),
                status: CheckStatus::Info,
                severity: CheckSeverity::Info,
                detail: format!("macOS IOKit utility available at {}", p.display()),
                remediation: None,
            }
        } else {
            PreflightCheck {
                id: "usb_utils".to_string(),
                status: CheckStatus::Info,
                severity: CheckSeverity::Info,
                detail: "ioreg not found; USB diagnostics limited".to_string(),
                remediation: None,
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Some(p) = resolve_executable("lsusb", None, &["/usr/bin/lsusb", "/bin/lsusb"]) {
            PreflightCheck {
                id: "usb_utils".to_string(),
                status: CheckStatus::Pass,
                severity: CheckSeverity::Warn,
                detail: format!("lsusb found at {}", p.display()),
                remediation: None,
            }
        } else {
            PreflightCheck {
                id: "usb_utils".to_string(),
                status: CheckStatus::Warn,
                severity: CheckSeverity::Warn,
                detail: "lsusb not found on PATH".to_string(),
                remediation: Some(
                    "Install usbutils (e.g. 'sudo apt install usbutils').".to_string(),
                ),
            }
        }
    }
}

pub fn check_udev_rules(path: &Path) -> PreflightCheck {
    if path.is_file() {
        match std::fs::File::open(path) {
            Ok(_) => PreflightCheck {
                id: "udev_rules".to_string(),
                status: CheckStatus::Pass,
                severity: CheckSeverity::Warn,
                detail: format!("{} present and readable", path.display()),
                remediation: None,
            },
            Err(e) => PreflightCheck {
                id: "udev_rules".to_string(),
                status: CheckStatus::Warn,
                severity: CheckSeverity::Warn,
                detail: format!("{} exists but is unreadable: {e}", path.display()),
                remediation: Some(
                    "Fix permissions (0644) and reload udev rules: sudo udevadm control --reload-rules && sudo udevadm trigger"
                        .to_string(),
                ),
            },
        }
    } else {
        PreflightCheck {
            id: "udev_rules".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: format!("{} not found", path.display()),
            remediation: Some(
                "Install deploy/udev/99-digi-dx.rules to /etc/udev/rules.d/99-digi-dx.rules and run 'sudo udevadm control --reload-rules && sudo udevadm trigger'."
                    .to_string(),
            ),
        }
    }
}

/// Pure evaluator for Linux `dialout`/`plugdev`/`audio` group membership and stale-session detection.
pub fn evaluate_os_groups(
    is_root: bool,
    username: &str,
    primary_gid: u32,
    effective_gids: &[u32],
    etc_group_content: &str,
) -> PreflightCheck {
    if is_root {
        return PreflightCheck {
            id: "os_groups".to_string(),
            status: CheckStatus::Info,
            severity: CheckSeverity::Info,
            detail: "Running as root (UID 0); serial/audio device group gates bypassed".to_string(),
            remediation: None,
        };
    }

    let required = ["dialout", "plugdev", "audio"];
    let mut missing_from_etc = Vec::new();
    let mut stale_groups = Vec::new();
    let mut ok_groups = Vec::new();

    for grp in required {
        let mut found_gid: Option<u32> = None;
        let mut listed_member = false;

        for line in etc_group_content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let parts: Vec<&str> = trimmed.split(':').collect();
            if parts.len() >= 4 && parts[0] == grp {
                found_gid = parts[2].parse::<u32>().ok();
                let members: Vec<&str> = parts[3]
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect();
                listed_member = members.contains(&username) || found_gid == Some(primary_gid);
                break;
            }
        }

        match found_gid {
            None => missing_from_etc.push(grp),
            Some(gid) => {
                let in_process = gid == primary_gid || effective_gids.contains(&gid);
                if in_process {
                    ok_groups.push(grp);
                } else if listed_member {
                    stale_groups.push(grp);
                } else {
                    missing_from_etc.push(grp);
                }
            }
        }
    }

    if stale_groups.is_empty() && missing_from_etc.is_empty() {
        return PreflightCheck {
            id: "os_groups".to_string(),
            status: CheckStatus::Pass,
            severity: CheckSeverity::Warn,
            detail: format!(
                "User '{username}' holds active groups: {}",
                ok_groups.join(", ")
            ),
            remediation: None,
        };
    }

    let mut details = Vec::new();
    let mut remedies = Vec::new();

    if !stale_groups.is_empty() {
        details.push(format!(
            "User '{username}' is in /etc/group ({}), but current process lacks effective GID (stale login or tmux server)",
            stale_groups.join(", ")
        ));
        remedies.push(
            "Log out and back in (and run 'tmux kill-server' if inside tmux), or run under systemd."
                .to_string(),
        );
    }

    if !missing_from_etc.is_empty() {
        details.push(format!(
            "User '{username}' missing from group(s): {}",
            missing_from_etc.join(", ")
        ));
        remedies.push(format!(
            "Run 'sudo usermod -aG dialout,plugdev,audio {username}' and start a fresh login."
        ));
    }

    PreflightCheck {
        id: "os_groups".to_string(),
        status: CheckStatus::Warn,
        severity: CheckSeverity::Warn,
        detail: details.join("; "),
        remediation: Some(remedies.join(" ")),
    }
}

#[cfg(target_os = "linux")]
fn check_os_groups_live() -> PreflightCheck {
    let euid = unsafe { libc::geteuid() };
    let primary_gid = unsafe { libc::getegid() };
    let is_root = euid == 0;

    let username = current_username(euid);
    let effective_gids = current_effective_gids();
    let etc_group = std::fs::read_to_string("/etc/group").unwrap_or_default();

    evaluate_os_groups(is_root, &username, primary_gid, &effective_gids, &etc_group)
}

#[cfg(target_os = "linux")]
fn current_username(euid: libc::uid_t) -> String {
    unsafe {
        let pwd = libc::getpwuid(euid);
        if !pwd.is_null() && !(*pwd).pw_name.is_null() {
            let c_str = std::ffi::CStr::from_ptr((*pwd).pw_name);
            if let Ok(s) = c_str.to_str() {
                return s.to_string();
            }
        }
    }
    env::var("USER").unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(target_os = "linux")]
fn current_effective_gids() -> Vec<u32> {
    let ngroups = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if ngroups <= 0 {
        return Vec::new();
    }
    let mut gids = vec![0 as libc::gid_t; ngroups as usize];
    let count = unsafe { libc::getgroups(ngroups, gids.as_mut_ptr()) };
    if count < 0 {
        return Vec::new();
    }
    gids.truncate(count as usize);
    gids.into_iter().collect()
}

fn check_audio_backend(probe_audio: bool) -> PreflightCheck {
    let host = cpal::default_host();
    let host_name = host.id().name();

    let input_names: Vec<String> = match host.input_devices() {
        Ok(devs) => devs.filter_map(|d| d.name().ok()).collect(),
        Err(e) => {
            return PreflightCheck {
                id: "audio_backend".to_string(),
                status: CheckStatus::Warn,
                severity: CheckSeverity::Warn,
                detail: format!("Audio host '{host_name}' input enumeration failed: {e}"),
                remediation: Some(
                    "Verify ALSA/CoreAudio soundcards, 'audio' group membership, or macOS Microphone permission."
                        .to_string(),
                ),
            };
        }
    };

    let output_names: Vec<String> = match host.output_devices() {
        Ok(devs) => devs.filter_map(|d| d.name().ok()).collect(),
        Err(e) => {
            return PreflightCheck {
                id: "audio_backend".to_string(),
                status: CheckStatus::Warn,
                severity: CheckSeverity::Warn,
                detail: format!("Audio host '{host_name}' output enumeration failed: {e}"),
                remediation: Some(
                    "Verify ALSA/CoreAudio soundcards and 'audio' group membership.".to_string(),
                ),
            };
        }
    };

    let mut probe_note = String::new();
    if probe_audio {
        let in_ok = host
            .default_input_device()
            .and_then(|d| d.default_input_config().ok())
            .is_some();
        let out_ok = host
            .default_output_device()
            .and_then(|d| d.default_output_config().ok())
            .is_some();
        probe_note = format!(" (default probe: in={in_ok}, out={out_ok})");
    }

    if input_names.is_empty() || output_names.is_empty() {
        PreflightCheck {
            id: "audio_backend".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: format!(
                "{host_name}: {} input(s), {} output(s){probe_note}",
                input_names.len(),
                output_names.len()
            ),
            remediation: Some(
                "Zero duplex-capable audio paths detected. Check USB audio cable, 'audio' group (Linux), or Microphone TCC permission (macOS)."
                    .to_string(),
            ),
        }
    } else {
        PreflightCheck {
            id: "audio_backend".to_string(),
            status: CheckStatus::Pass,
            severity: CheckSeverity::Warn,
            detail: format!(
                "{host_name}: {} input(s), {} output(s){probe_note}",
                input_names.len(),
                output_names.len()
            ),
            remediation: None,
        }
    }
}

fn check_ftxr_decoder(override_path: Option<&Path>) -> PreflightCheck {
    let Some(ftxr_path) = crate::modem::ftxr::find_ftxr_candidate(override_path) else {
        return PreflightCheck {
            id: "ft8_decoder_ftxr".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: "ftxr-modem binary not found; built-in MIT ft8_lib fallback decoder will be used"
                .to_string(),
            remediation: Some(
                "Install ftxr-modem from https://github.com/mpmbq2/ftxr-modem/releases (or re-run scripts/install.sh) for full weak-signal FT8/FT4 decoding."
                    .to_string(),
            ),
        };
    };

    match crate::modem::ftxr::verify_ftxr_binary(&ftxr_path) {
        Ok(info) => PreflightCheck {
            id: "ft8_decoder_ftxr".to_string(),
            status: CheckStatus::Pass,
            severity: CheckSeverity::Warn,
            detail: format!(
                "ftxr-modem {} (ipc-v{}) verified at {}",
                info.version,
                info.ipc_protocol_version,
                info.path.display()
            ),
            remediation: None,
        },
        Err(reason) => PreflightCheck {
            id: "ft8_decoder_ftxr".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: format!("ftxr-modem probe failed: {reason}"),
            remediation: Some(
                "Install a matching ftxr-modem release binary (IPC v1) or verify DIGI_DX_FTXR_PATH."
                    .to_string(),
            ),
        },
    }
}

fn check_jt9_decoder(override_path: Option<&Path>) -> PreflightCheck {
    let fallback_paths = [
        "/usr/local/lib/digi-dx/jt9",
        "/Applications/wsjtx.app/Contents/MacOS/jt9",
    ];
    let Some(jt9_path) = resolve_executable("jt9", override_path, &fallback_paths) else {
        return PreflightCheck {
            id: "ft8_decoder_jt9".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: "jt9 binary not found; built-in MIT ft8_lib fallback decoder will be used"
                .to_string(),
            remediation: Some(
                "Install wsjtx (or headless wsjtx-utils) for full WSJT-X weak-signal sensitivity."
                    .to_string(),
            ),
        };
    };

    match Command::new(&jt9_path).arg("-h").output() {
        Ok(out) if out.status.success() => PreflightCheck {
            id: "ft8_decoder_jt9".to_string(),
            status: CheckStatus::Pass,
            severity: CheckSeverity::Warn,
            detail: format!("jt9 native execution verified at {}", jt9_path.display()),
            remediation: None,
        },
        Ok(out) => PreflightCheck {
            id: "ft8_decoder_jt9".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: format!(
                "jt9 at {} exited with {} (falling back to ft8_lib)",
                jt9_path.display(),
                out.status
            ),
            remediation: Some(
                "Verify jt9 architecture matches host ('file jt9') and required shared libraries are installed."
                    .to_string(),
            ),
        },
        Err(e) => PreflightCheck {
            id: "ft8_decoder_jt9".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: format!(
                "jt9 at {} failed to launch: {e} (falling back to ft8_lib)",
                jt9_path.display()
            ),
            remediation: Some(
                "Check for wrong-architecture Exec format error or missing Qt/FFTW runtime libs."
                    .to_string(),
            ),
        },
    }
}

fn check_sqlite_storage(data_dir: &Path) -> PreflightCheck {
    let db_path = data_dir.join("digi-dx.db");
    match StateStore::open(&db_path) {
        Ok(store) => match (store.journal_mode(), store.quick_check()) {
            (Ok(mode), Ok(qc)) if qc.eq_ignore_ascii_case("ok") => PreflightCheck {
                id: "sqlite_storage".to_string(),
                status: CheckStatus::Pass,
                severity: CheckSeverity::Fatal,
                detail: format!(
                    "SQLite ready at {} (journal_mode={}, quick_check={})",
                    db_path.display(),
                    mode,
                    qc
                ),
                remediation: None,
            },
            (Ok(mode), Ok(qc)) => PreflightCheck {
                id: "sqlite_storage".to_string(),
                status: CheckStatus::Fail,
                severity: CheckSeverity::Fatal,
                detail: format!(
                    "SQLite quick_check failed at {} (journal_mode={}, result={})",
                    db_path.display(),
                    mode,
                    qc
                ),
                remediation: Some("Inspect or recover SQLite database file.".to_string()),
            },
            (Err(e), _) | (_, Err(e)) => PreflightCheck {
                id: "sqlite_storage".to_string(),
                status: CheckStatus::Fail,
                severity: CheckSeverity::Fatal,
                detail: format!("SQLite health pragma failed at {}: {e}", db_path.display()),
                remediation: Some("Check filesystem permissions and disk health.".to_string()),
            },
        },
        Err(e) => PreflightCheck {
            id: "sqlite_storage".to_string(),
            status: CheckStatus::Fail,
            severity: CheckSeverity::Fatal,
            detail: format!("Cannot open/write SQLite DB at {}: {e}", db_path.display()),
            remediation: Some(format!(
                "Fix permissions on {} or set DIGI_DX_DATA_DIR to a writable directory.",
                data_dir.display()
            )),
        },
    }
}

fn check_system_clock_sync() -> PreflightCheck {
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = Command::new("timedatectl").arg("show").output() {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let ntp_sync = stdout
                    .lines()
                    .find_map(|l| l.strip_prefix("NTPSynchronized="))
                    .map(|v| v.trim().eq_ignore_ascii_case("yes"));

                if ntp_sync == Some(true) {
                    let offset_ms = Command::new("timedatectl")
                        .arg("timesync-status")
                        .output()
                        .ok()
                        .filter(|o| o.status.success())
                        .and_then(|o| {
                            let text = String::from_utf8_lossy(&o.stdout);
                            parse_timesync_offset_ms(&text)
                        });

                    if let Some(ms) = offset_ms {
                        if ms.abs() > 1000.0 {
                            return PreflightCheck {
                                id: "system_clock_sync".to_string(),
                                status: CheckStatus::Warn,
                                severity: CheckSeverity::Warn,
                                detail: format!(
                                    "NTP active, but clock offset is {ms:.2} ms (> 1000 ms)"
                                ),
                                remediation: Some(
                                    "Force NTP sync ('chronyc makestep' or restart systemd-timesyncd); FT8 degrades above ±2.0s."
                                        .to_string(),
                                ),
                            };
                        }
                        return PreflightCheck {
                            id: "system_clock_sync".to_string(),
                            status: CheckStatus::Pass,
                            severity: CheckSeverity::Warn,
                            detail: format!("NTP synchronized (offset {ms:.3} ms)"),
                            remediation: None,
                        };
                    }

                    return PreflightCheck {
                        id: "system_clock_sync".to_string(),
                        status: CheckStatus::Pass,
                        severity: CheckSeverity::Warn,
                        detail: "NTP synchronized (timedatectl NTPSynchronized=yes)".to_string(),
                        remediation: None,
                    };
                } else if ntp_sync == Some(false) {
                    // Check chronyc fallback before warning
                    if let Some(check) = try_chronyc_check() {
                        return check;
                    }
                    return PreflightCheck {
                        id: "system_clock_sync".to_string(),
                        status: CheckStatus::Warn,
                        severity: CheckSeverity::Warn,
                        detail: "System clock is not NTP synchronized (NTPSynchronized=no)"
                            .to_string(),
                        remediation: Some(
                            "Enable systemd-timesyncd or chrony; FT8 slots require sub-second UTC alignment."
                                .to_string(),
                        ),
                    };
                }
            }
        }

        if let Some(check) = try_chronyc_check() {
            return check;
        }

        PreflightCheck {
            id: "system_clock_sync".to_string(),
            status: CheckStatus::Warn,
            severity: CheckSeverity::Warn,
            detail: "Unable to verify NTP synchronization (timedatectl/chronyc unavailable)"
                .to_string(),
            remediation: Some("Enable systemd-timesyncd or chrony.".to_string()),
        }
    }

    #[cfg(target_os = "macos")]
    {
        PreflightCheck {
            id: "system_clock_sync".to_string(),
            status: CheckStatus::Info,
            severity: CheckSeverity::Info,
            detail:
                "macOS timed NTP management assumed active (check System Settings -> Date & Time)"
                    .to_string(),
            remediation: None,
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        PreflightCheck {
            id: "system_clock_sync".to_string(),
            status: CheckStatus::Info,
            severity: CheckSeverity::Info,
            detail: "Clock sync probe not implemented on this OS".to_string(),
            remediation: None,
        }
    }
}

#[cfg(target_os = "linux")]
fn try_chronyc_check() -> Option<PreflightCheck> {
    let out = Command::new("chronyc").arg("tracking").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let offset_ms = text.lines().find_map(|line| {
        let rest = line.strip_prefix("Last offset")?;
        let val_part = rest.split(':').nth(1)?.trim();
        let num_str = val_part.split_whitespace().next()?;
        let secs: f64 = num_str.parse().ok()?;
        Some(secs * 1000.0)
    });
    if let Some(ms) = offset_ms {
        if ms.abs() > 1000.0 {
            Some(PreflightCheck {
                id: "system_clock_sync".to_string(),
                status: CheckStatus::Warn,
                severity: CheckSeverity::Warn,
                detail: format!("chrony offset {ms:.2} ms exceeds 1000 ms"),
                remediation: Some("Run 'sudo chronyc makestep' to resync UTC clock.".to_string()),
            })
        } else {
            Some(PreflightCheck {
                id: "system_clock_sync".to_string(),
                status: CheckStatus::Pass,
                severity: CheckSeverity::Warn,
                detail: format!("chrony synchronized (offset {ms:.3} ms)"),
                remediation: None,
            })
        }
    } else {
        Some(PreflightCheck {
            id: "system_clock_sync".to_string(),
            status: CheckStatus::Pass,
            severity: CheckSeverity::Warn,
            detail: "chrony tracking active".to_string(),
            remediation: None,
        })
    }
}

pub fn parse_timesync_offset_ms(text: &str) -> Option<f64> {
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Offset:") {
            let token = rest.trim();
            if let Some(v) = token.strip_suffix("us") {
                return v.trim().parse::<f64>().ok().map(|u| u / 1000.0);
            }
            if let Some(v) = token.strip_suffix("ms") {
                return v.trim().parse::<f64>().ok();
            }
            if let Some(v) = token.strip_suffix('s') {
                return v.trim().parse::<f64>().ok().map(|s| s * 1000.0);
            }
        }
    }
    None
}

pub fn resolve_executable(
    name: &str,
    override_path: Option<&Path>,
    extra_candidates: &[&str],
) -> Option<PathBuf> {
    if let Some(p) = override_path {
        if is_executable_file(p) {
            return Some(p.to_path_buf());
        }
        return None;
    }

    if let Some(path_var) = env::var_os("PATH") {
        for dir in env::split_paths(&path_var) {
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }

    for extra in extra_candidates {
        let p = Path::new(extra);
        if is_executable_file(p) {
            return Some(p.to_path_buf());
        }
    }

    None
}

fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            return meta.permissions().mode() & 0o111 != 0;
        }
        false
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn print_human_report(report: &PreflightReport) {
    println!(
        "Digi-Dx v2 Preflight ({}/{}) — status: {:?}, decoder: {}",
        report.platform.os, report.platform.arch, report.overall_status, report.active_ft8_decoder
    );
    println!("Checked at: {}", report.checked_at_utc);
    for c in &report.checks {
        let tag = match c.status {
            CheckStatus::Pass => "PASS",
            CheckStatus::Warn => "WARN",
            CheckStatus::Fail => "FAIL",
            CheckStatus::Info => "INFO",
        };
        println!("  [{tag}] {:<18} {}", c.id, c.detail);
        if let Some(rem) = &c.remediation {
            println!("         remediation: {rem}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hamlib_versions_and_flags_older_than_4_5() {
        assert_eq!(
            parse_hamlib_version("rigctl Hamlib 4.5.5 Apr 05 11:43:08Z 2023 SHA=6eecd3"),
            Some((4, 5, Some(5)))
        );
        assert_eq!(
            parse_hamlib_version("rigctld Hamlib 4.3.1"),
            Some((4, 3, Some(1)))
        );
        assert_eq!(parse_hamlib_version("Hamlib 5.0"), Some((5, 0, None)));

        let pass = evaluate_hamlib_version(Some("rigctl Hamlib 4.5.5"));
        assert_eq!(pass.status, CheckStatus::Pass);

        let warn = evaluate_hamlib_version(Some("rigctl Hamlib 4.3.1"));
        assert_eq!(warn.status, CheckStatus::Warn);
    }

    #[test]
    fn detects_stale_group_membership_and_missing_groups() {
        let etc_group = "\
dialout:x:20:matt
audio:x:29:pulse,matt
plugdev:x:46:matt
";
        // Active process has audio (29) and plugdev (46), but NOT dialout (20) -> stale group!
        let stale = evaluate_os_groups(false, "matt", 1000, &[29, 46, 1000], etc_group);
        assert_eq!(stale.status, CheckStatus::Warn);
        assert!(stale.detail.contains("dialout"));
        assert!(stale.detail.contains("stale login or tmux server"));
        assert!(stale
            .remediation
            .as_deref()
            .unwrap()
            .contains("tmux kill-server"));

        // Active process has all 3 -> pass
        let ok = evaluate_os_groups(false, "matt", 1000, &[20, 29, 46, 1000], etc_group);
        assert_eq!(ok.status, CheckStatus::Pass);

        // Root -> info
        let root = evaluate_os_groups(true, "root", 0, &[0], etc_group);
        assert_eq!(root.status, CheckStatus::Info);
    }

    #[test]
    fn parses_timesync_offsets() {
        assert!((parse_timesync_offset_ms("Offset: -102us\n").unwrap() - (-0.102)).abs() < 1e-6);
        assert!((parse_timesync_offset_ms("Offset: 15.4ms\n").unwrap() - 15.4).abs() < 1e-6);
        assert!((parse_timesync_offset_ms("Offset: 1.8s\n").unwrap() - 1800.0).abs() < 1e-6);
    }

    #[test]
    fn checks_udev_rules_file_presence() {
        let dir = tempfile::tempdir().unwrap();
        let missing = check_udev_rules(&dir.path().join("99-digi-dx.rules"));
        assert_eq!(missing.status, CheckStatus::Warn);

        let rules_path = dir.path().join("99-digi-dx.rules");
        std::fs::write(&rules_path, "# test\n").unwrap();
        let present = check_udev_rules(&rules_path);
        assert_eq!(present.status, CheckStatus::Pass);
    }
}
