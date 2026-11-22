use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use notify::{Event, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::store::{RadioProfile, UsbDeviceRecord};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedSerialDevice {
    pub device_key: String,
    pub os_path: String,
    pub real_tty_path: Option<String>,
    pub usb_vid: Option<String>,
    pub usb_pid: Option<String>,
    pub usb_serial: Option<String>,
    pub usb_interface: Option<String>,
    pub usb_topology_path: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

pub trait DeviceScanner: Send + Sync {
    fn scan_serial(&self) -> Vec<ScannedSerialDevice>;
}

#[derive(Debug, Clone)]
pub struct OsDeviceScanner {
    pub serial_by_id_dir: PathBuf,
    pub sysfs_tty_root: PathBuf,
}

impl Default for OsDeviceScanner {
    fn default() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self {
                serial_by_id_dir: PathBuf::from("/dev"),
                sysfs_tty_root: PathBuf::from("/sys/class/tty"),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self {
                serial_by_id_dir: PathBuf::from("/dev/serial/by-id"),
                sysfs_tty_root: PathBuf::from("/sys/class/tty"),
            }
        }
    }
}

impl DeviceScanner for OsDeviceScanner {
    fn scan_serial(&self) -> Vec<ScannedSerialDevice> {
        #[cfg(target_os = "macos")]
        {
            scan_macos_cu_dir(&self.serial_by_id_dir)
        }
        #[cfg(not(target_os = "macos"))]
        {
            scan_linux_by_id(&self.serial_by_id_dir, &self.sysfs_tty_root)
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn scan_linux_by_id(by_id_dir: &Path, sysfs_tty_root: &Path) -> Vec<ScannedSerialDevice> {
    let mut devices = Vec::new();
    let Ok(entries) = fs::read_dir(by_id_dir) else {
        return devices;
    };

    for entry in entries.flatten() {
        let os_path = entry.path();
        let path_str = os_path.display().to_string();

        let real_tty_path = fs::canonicalize(&os_path)
            .ok()
            .or_else(|| {
                fs::read_link(&os_path).ok().map(|target| {
                    if target.is_absolute() {
                        target
                    } else {
                        by_id_dir.join(target)
                    }
                })
            })
            .map(|p| p.display().to_string());

        let tty_name = real_tty_path
            .as_deref()
            .and_then(|p| Path::new(p).file_name())
            .and_then(|n| n.to_str())
            .map(str::to_string);

        let meta = tty_name
            .as_deref()
            .map(|tty| {
                let sys_dev = sysfs_tty_root.join(tty).join("device");
                let resolved = fs::canonicalize(&sys_dev).unwrap_or(sys_dev);
                read_sysfs_usb_metadata(&resolved)
            })
            .unwrap_or_default();

        devices.push(ScannedSerialDevice {
            device_key: path_str.clone(),
            os_path: path_str,
            real_tty_path,
            usb_vid: meta.usb_vid,
            usb_pid: meta.usb_pid,
            usb_serial: meta.usb_serial,
            usb_interface: meta.usb_interface,
            usb_topology_path: meta.usb_topology_path,
            manufacturer: meta.manufacturer,
            product: meta.product,
        });
    }

    devices.sort_by(|a, b| a.device_key.cmp(&b.device_key));
    devices
}

#[cfg(target_os = "macos")]
fn scan_macos_cu_dir(dev_dir: &Path) -> Vec<ScannedSerialDevice> {
    let mut devices = Vec::new();
    let Ok(entries) = fs::read_dir(dev_dir) else {
        return devices;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with("cu.usb")
            || name_str.starts_with("cu.SLAB")
            || name_str.starts_with("cu.wchusb")
            || name_str.starts_with("cu.FTDI")
        {
            let path_str = dev_dir.join(name_str.as_ref()).display().to_string();
            devices.push(ScannedSerialDevice {
                device_key: path_str.clone(),
                os_path: path_str,
                real_tty_path: None,
                usb_vid: None,
                usb_pid: None,
                usb_serial: None,
                usb_interface: None,
                usb_topology_path: None,
                manufacturer: None,
                product: None,
            });
        }
    }
    devices.sort_by(|a, b| a.device_key.cmp(&b.device_key));
    devices
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SysfsUsbMeta {
    pub usb_vid: Option<String>,
    pub usb_pid: Option<String>,
    pub usb_serial: Option<String>,
    pub usb_interface: Option<String>,
    pub usb_topology_path: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

pub fn read_sysfs_usb_metadata(tty_device_dir: &Path) -> SysfsUsbMeta {
    let mut meta = SysfsUsbMeta::default();
    if !tty_device_dir.exists() {
        return meta;
    }

    meta.usb_interface =
        read_trimmed_attr(&tty_device_dir.join("bInterfaceNumber")).or_else(|| {
            tty_device_dir
                .parent()
                .and_then(|p| read_trimmed_attr(&p.join("bInterfaceNumber")))
        });

    let mut cur: Option<&Path> = Some(tty_device_dir);
    for _ in 0..5 {
        let Some(dir) = cur else { break };
        let vid_path = dir.join("idVendor");
        if vid_path.is_file() {
            meta.usb_vid = read_trimmed_attr(&vid_path).map(|s| s.to_ascii_lowercase());
            meta.usb_pid =
                read_trimmed_attr(&dir.join("idProduct")).map(|s| s.to_ascii_lowercase());
            meta.usb_serial = read_trimmed_attr(&dir.join("serial"));
            meta.manufacturer = read_trimmed_attr(&dir.join("manufacturer"));
            meta.product = read_trimmed_attr(&dir.join("product"));
            meta.usb_topology_path = dir.file_name().and_then(|n| n.to_str()).map(str::to_string);
            break;
        }
        cur = dir.parent();
    }

    meta
}

fn read_trimmed_attr(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Thread-safe mock scanner for integration tests.
#[derive(Clone, Default)]
pub struct MockDeviceScanner {
    devices: Arc<RwLock<Vec<ScannedSerialDevice>>>,
}

impl MockDeviceScanner {
    pub fn new(initial: Vec<ScannedSerialDevice>) -> Self {
        Self {
            devices: Arc::new(RwLock::new(initial)),
        }
    }

    pub fn set_devices(&self, devices: Vec<ScannedSerialDevice>) {
        if let Ok(mut guard) = self.devices.write() {
            *guard = devices;
        }
    }

    pub fn push_device(&self, dev: ScannedSerialDevice) {
        if let Ok(mut guard) = self.devices.write() {
            guard.retain(|d| d.device_key != dev.device_key);
            guard.push(dev);
        }
    }

    pub fn remove_device(&self, device_key: &str) {
        if let Ok(mut guard) = self.devices.write() {
            guard.retain(|d| d.device_key != device_key);
        }
    }
}

impl DeviceScanner for MockDeviceScanner {
    fn scan_serial(&self) -> Vec<ScannedSerialDevice> {
        self.devices.read().map(|g| g.clone()).unwrap_or_default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchOutcome {
    Matched {
        device: Box<ScannedSerialDevice>,
        topology_warning: Option<String>,
    },
    Ambiguous(String),
    NotFound,
}

/// Persistent hardware identity matching precedence (`docs/architecture.md` §4.1):
/// 1. Exact `device_key` / `os_path` match.
/// 2. Hardware fingerprint `(usb_vid, usb_pid, usb_serial, usb_interface)` when serial is present.
/// 3. Fallback `(usb_vid, usb_pid, usb_topology_path, usb_interface)` when serial is absent (with warning).
/// 4. Refuse ambiguous swaps across identical serial-less adapters.
pub fn match_profile_to_device(
    profile: &RadioProfile,
    historical_record: Option<&UsbDeviceRecord>,
    connected: &[ScannedSerialDevice],
) -> MatchOutcome {
    let Some(ref target_key) = profile.serial_device_key else {
        return MatchOutcome::NotFound;
    };

    if let Some(exact) = connected
        .iter()
        .find(|d| d.device_key == *target_key || d.os_path == *target_key)
    {
        return MatchOutcome::Matched {
            device: Box::new(exact.clone()),
            topology_warning: None,
        };
    }

    let Some(hist) = historical_record else {
        return MatchOutcome::NotFound;
    };

    if let (Some(vid), Some(pid), Some(serial)) = (
        hist.usb_vid.as_deref(),
        hist.usb_pid.as_deref(),
        hist.usb_serial.as_deref().filter(|s| !s.is_empty()),
    ) {
        let matches: Vec<&ScannedSerialDevice> = connected
            .iter()
            .filter(|d| {
                d.usb_vid.as_deref() == Some(vid)
                    && d.usb_pid.as_deref() == Some(pid)
                    && d.usb_serial.as_deref() == Some(serial)
                    && (hist.usb_interface.is_none() || d.usb_interface == hist.usb_interface)
            })
            .collect();
        if matches.len() == 1 {
            return MatchOutcome::Matched {
                device: Box::new(matches[0].clone()),
                topology_warning: None,
            };
        }
        if matches.len() > 1 {
            return MatchOutcome::Ambiguous(format!(
                "Multiple devices matched {vid}:{pid}:{serial}; re-bind explicitly"
            ));
        }
    }

    // Serial-less adapter fallback: match by (vid, pid, topology, interface)
    if let (Some(vid), Some(pid), Some(topo)) = (
        hist.usb_vid.as_deref(),
        hist.usb_pid.as_deref(),
        hist.usb_topology_path.as_deref().filter(|s| !s.is_empty()),
    ) {
        let same_vid_pid: Vec<&ScannedSerialDevice> = connected
            .iter()
            .filter(|d| d.usb_vid.as_deref() == Some(vid) && d.usb_pid.as_deref() == Some(pid))
            .collect();

        let topo_matches: Vec<&ScannedSerialDevice> = same_vid_pid
            .iter()
            .copied()
            .filter(|d| {
                d.usb_topology_path.as_deref() == Some(topo)
                    && (hist.usb_interface.is_none() || d.usb_interface == hist.usb_interface)
            })
            .collect();

        if topo_matches.len() == 1 {
            return MatchOutcome::Matched {
                device: Box::new(topo_matches[0].clone()),
                topology_warning: Some(format!(
                    "Matched serial-less USB adapter {vid}:{pid} by USB port topology '{topo}'; keep it in the same hub port or use an adapter with a unique USB serial"
                )),
            };
        }

        if same_vid_pid.len() > 1 {
            return MatchOutcome::Ambiguous(format!(
                "Ambiguous serial-less USB adapters ({vid}:{pid}); operator re-bind required"
            ));
        }
    }

    MatchOutcome::NotFound
}

pub struct WatcherGuards {
    _fs_watcher: Option<notify::RecommendedWatcher>,
}

pub fn spawn_hotplug_watchers(
    watch_dir: &Path,
    enable_os_netlink: bool,
    debounce: Duration,
    reconcile_period: Duration,
    shutdown: CancellationToken,
    on_trigger: Arc<dyn Fn() + Send + Sync>,
) -> WatcherGuards {
    let (tx, mut rx) = mpsc::channel::<()>(64);

    let fs_watcher = create_fs_watcher(watch_dir, tx.clone());

    #[cfg(target_os = "linux")]
    if enable_os_netlink {
        spawn_linux_netlink_uevent_thread(tx.clone(), shutdown.clone());
    }
    #[cfg(not(target_os = "linux"))]
    let _ = enable_os_netlink;

    // Debounce + periodic reconciliation driver task
    let shutdown_loop = shutdown.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(reconcile_period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Skip immediate initial tick since supervisor runs reconcile_now() on startup.
        interval.tick().await;

        loop {
            tokio::select! {
                _ = shutdown_loop.cancelled() => break,
                _ = interval.tick() => {
                    on_trigger();
                }
                Some(()) = rx.recv() => {
                    // Trailing debounce window
                    loop {
                        tokio::select! {
                            _ = shutdown_loop.cancelled() => return,
                            _ = tokio::time::sleep(debounce) => break,
                            more = rx.recv() => {
                                if more.is_none() {
                                    break;
                                }
                            }
                        }
                    }
                    on_trigger();
                }
            }
        }
    });

    WatcherGuards {
        _fs_watcher: fs_watcher,
    }
}

fn create_fs_watcher(watch_dir: &Path, tx: mpsc::Sender<()>) -> Option<notify::RecommendedWatcher> {
    let target = if watch_dir.exists() {
        watch_dir.to_path_buf()
    } else {
        watch_dir
            .parent()
            .filter(|p| p.exists() && p != &Path::new("/"))?
            .to_path_buf()
    };

    let res = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if let Ok(ev) = event {
            use notify::EventKind;
            if matches!(
                ev.kind,
                EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
            ) {
                let _ = tx.try_send(());
            }
        }
    });

    match res {
        Ok(mut watcher) => {
            if let Err(e) = watcher.watch(&target, RecursiveMode::NonRecursive) {
                warn!(path = %target.display(), error = %e, "failed to watch serial path");
                None
            } else {
                debug!(path = %target.display(), "hot-plug fs watcher attached");
                Some(watcher)
            }
        }
        Err(e) => {
            warn!(error = %e, "failed to initialize notify watcher");
            None
        }
    }
}

#[cfg(target_os = "linux")]
fn spawn_linux_netlink_uevent_thread(tx: mpsc::Sender<()>, shutdown: CancellationToken) {
    std::thread::Builder::new()
        .name("digi-dx-uevent".to_string())
        .spawn(move || {
            let sock = unsafe {
                libc::socket(
                    libc::AF_NETLINK,
                    libc::SOCK_RAW | libc::SOCK_CLOEXEC,
                    libc::NETLINK_KOBJECT_UEVENT,
                )
            };
            if sock < 0 {
                warn!("NETLINK_KOBJECT_UEVENT socket unavailable; relying on fs watcher + 5s reconciler");
                return;
            }

            // Group 2 receives udev-processed uevents (fired after /dev/serial/by-id symlinks exist);
            // fallback to group 1 (kernel uevents) if group 2 fails.
            let mut bound = false;
            for group in [2_u32, 1_u32] {
                let mut addr: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
                addr.nl_family = libc::AF_NETLINK as libc::sa_family_t;
                addr.nl_pid = 0;
                addr.nl_groups = group;
                let rc = unsafe {
                    libc::bind(
                        sock,
                        (&raw const addr).cast::<libc::sockaddr>(),
                        std::mem::size_of::<libc::sockaddr_nl>() as libc::socklen_t,
                    )
                };
                if rc == 0 {
                    debug!(nl_group = group, "Linux netlink uevent monitor bound");
                    bound = true;
                    break;
                }
            }

            if !bound {
                warn!("NETLINK_KOBJECT_UEVENT bind failed; relying on fs watcher + 5s reconciler");
                unsafe {
                    libc::close(sock);
                }
                return;
            }

            let mut buf = [0_u8; 8192];
            while !shutdown.is_cancelled() {
                let mut pfd = libc::pollfd {
                    fd: sock,
                    events: libc::POLLIN,
                    revents: 0,
                };
                let poll_rc = unsafe { libc::poll(&raw mut pfd, 1, 200) };
                if poll_rc <= 0 {
                    continue;
                }
                if (pfd.revents & libc::POLLIN) == 0 {
                    continue;
                }
                let n = unsafe {
                    libc::recv(sock, buf.as_mut_ptr().cast::<libc::c_void>(), buf.len(), 0)
                };
                if n > 0 {
                    let payload = String::from_utf8_lossy(&buf[..n as usize]);
                    if payload.contains("SUBSYSTEM=tty")
                        || payload.contains("SUBSYSTEM=usb")
                        || payload.contains("SUBSYSTEM=sound")
                    {
                        let _ = tx.try_send(());
                    }
                }
            }

            unsafe {
                libc::close(sock);
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reads_sysfs_usb_metadata_tree() {
        let dir = tempdir().unwrap();
        let usb_dev = dir.path().join("3-2.1");
        let iface_dir = usb_dev.join("3-2.1:1.0");
        let tty_dir = iface_dir.join("ttyUSB1");
        fs::create_dir_all(&tty_dir).unwrap();

        fs::write(usb_dev.join("idVendor"), "10C4\n").unwrap();
        fs::write(usb_dev.join("idProduct"), "EA60\n").unwrap();
        fs::write(usb_dev.join("serial"), "IC-7300 02029580\n").unwrap();
        fs::write(usb_dev.join("manufacturer"), "Silicon Labs\n").unwrap();
        fs::write(usb_dev.join("product"), "CP2102 USB to UART\n").unwrap();
        fs::write(iface_dir.join("bInterfaceNumber"), "00\n").unwrap();

        let meta = read_sysfs_usb_metadata(&tty_dir);
        assert_eq!(meta.usb_vid.as_deref(), Some("10c4"));
        assert_eq!(meta.usb_pid.as_deref(), Some("ea60"));
        assert_eq!(meta.usb_serial.as_deref(), Some("IC-7300 02029580"));
        assert_eq!(meta.usb_interface.as_deref(), Some("00"));
        assert_eq!(meta.usb_topology_path.as_deref(), Some("3-2.1"));
        assert_eq!(meta.manufacturer.as_deref(), Some("Silicon Labs"));
    }

    #[test]
    fn hardware_matching_precedence_and_ambiguity_guard() {
        let profile = RadioProfile {
            radio_id: "rad_1".into(),
            name: "CH340 Rig".into(),
            hamlib_model: 2016,
            is_dummy: false,
            serial_device_key: Some("/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0".into()),
            serial_baud_rate: 9600,
            civ_address: None,
            ptt_method: "cat".into(),
            rig_options_json: "{}".into(),
            audio_device_uid: None,
            audio_device_name: None,
            audio_rx_channel: "mono".into(),
            audio_tx_gain_db: -6.0,
            rigctld_port: 4532,
            auto_connect: true,
            last_dial_freq_hz: None,
            created_at_utc: "2026-11-21T00:00:00Z".into(),
            updated_at_utc: "2026-11-21T00:00:00Z".into(),
        };

        let hist = UsbDeviceRecord {
            device_key: "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0".into(),
            os_path: "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0".into(),
            real_tty_path: Some("/dev/ttyUSB0".into()),
            usb_vid: Some("1a86".into()),
            usb_pid: Some("7523".into()),
            usb_serial: None,
            usb_interface: Some("00".into()),
            usb_topology_path: Some("3-1".into()),
            manufacturer: Some("WCH".into()),
            product: Some("CH340".into()),
            is_connected: false,
            first_seen_utc: "2026-11-21T00:00:00Z".into(),
            last_seen_utc: "2026-11-21T00:00:00Z".into(),
        };

        // Topology match emits warning for serial-less adapter
        let dev_topo = ScannedSerialDevice {
            device_key: "/dev/serial/by-id/usb-1a86_alt-port0".into(),
            os_path: "/dev/serial/by-id/usb-1a86_alt-port0".into(),
            real_tty_path: Some("/dev/ttyUSB2".into()),
            usb_vid: Some("1a86".into()),
            usb_pid: Some("7523".into()),
            usb_serial: None,
            usb_interface: Some("00".into()),
            usb_topology_path: Some("3-1".into()),
            manufacturer: Some("WCH".into()),
            product: Some("CH340".into()),
        };
        let out = match_profile_to_device(&profile, Some(&hist), std::slice::from_ref(&dev_topo));
        assert!(matches!(
            out,
            MatchOutcome::Matched {
                topology_warning: Some(_),
                ..
            }
        ));

        // Two identical serial-less adapters in different ports -> Ambiguous
        let dev_a = ScannedSerialDevice {
            usb_topology_path: Some("3-4".into()),
            ..dev_topo.clone()
        };
        let dev_b = ScannedSerialDevice {
            device_key: "/dev/serial/by-id/usb-1a86_other-port0".into(),
            os_path: "/dev/serial/by-id/usb-1a86_other-port0".into(),
            usb_topology_path: Some("3-5".into()),
            ..dev_topo
        };
        let out_ambig = match_profile_to_device(&profile, Some(&hist), &[dev_a, dev_b]);
        assert!(matches!(out_ambig, MatchOutcome::Ambiguous(_)));
    }
}
