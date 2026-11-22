use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};

use crate::supervisor::discovery::read_sysfs_usb_metadata;

static AUDIO_DEVICE_OPEN_LOCK: Mutex<()> = Mutex::new(());

/// Serializes ALSA device enumeration and `cpal::Device` open/close windows so background
/// enumeration never races with opening an active RX/TX stream.
pub fn lock_audio_open() -> MutexGuard<'static, ()> {
    AUDIO_DEVICE_OPEN_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioDeviceInfo {
    pub index: usize,
    pub name: String,
    pub supports_input: bool,
    pub supports_output: bool,
    pub max_input_channels: u16,
    pub max_output_channels: u16,
    pub supports_48khz: bool,
    pub default_sample_rate: Option<u32>,
    pub host_name: String,
    pub device_uid: String,
    pub card_id: Option<String>,
    pub usb_vid: Option<String>,
    pub usb_pid: Option<String>,
    pub usb_serial: Option<String>,
    pub usb_topology_path: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlsaCardUsbInfo {
    pub card_id: String,
    pub usb_vid: Option<String>,
    pub usb_pid: Option<String>,
    pub usb_serial: Option<String>,
    pub usb_topology_path: Option<String>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAlsaSelector {
    pub pcm_prefix: String,
    pub card_id: Option<String>,
    pub dev_suffix: String,
}

pub fn parse_alsa_card_selector(name: &str) -> ParsedAlsaSelector {
    let (pcm_prefix, rest) = match name.split_once(':') {
        Some((prefix, remainder)) => (prefix.trim().to_string(), Some(remainder)),
        None => ("default".to_string(), None),
    };

    let mut card_id = None;
    let mut dev_suffix = "default".to_string();

    if let Some(params) = rest {
        for part in params.split(',') {
            let trimmed = part.trim();
            if let Some(card) = trimmed.strip_prefix("CARD=") {
                if !card.is_empty() {
                    card_id = Some(card.to_string());
                }
            } else if let Some(dev) = trimmed.strip_prefix("DEV=") {
                if !dev.is_empty() {
                    dev_suffix = format!("dev{dev}");
                }
            }
        }
    }

    ParsedAlsaSelector {
        pcm_prefix,
        card_id,
        dev_suffix,
    }
}

pub fn scan_linux_sound_cards(sysfs_sound_root: &Path) -> HashMap<String, AlsaCardUsbInfo> {
    let mut out = HashMap::new();
    let Ok(entries) = fs::read_dir(sysfs_sound_root) else {
        return out;
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let Some(suffix) = name_str.strip_prefix("card") else {
            continue;
        };
        if suffix.is_empty() || !suffix.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }

        let card_dir = entry.path();
        let Ok(raw_id) = fs::read_to_string(card_dir.join("id")) else {
            continue;
        };
        let card_id = raw_id.trim().to_string();
        if card_id.is_empty() {
            continue;
        }

        let dev_link = card_dir.join("device");
        let resolved_dev = fs::canonicalize(&dev_link).unwrap_or(dev_link);
        let meta = read_sysfs_usb_metadata(&resolved_dev);

        out.insert(
            card_id.clone(),
            AlsaCardUsbInfo {
                card_id,
                usb_vid: meta.usb_vid,
                usb_pid: meta.usb_pid,
                usb_serial: meta.usb_serial,
                usb_topology_path: meta.usb_topology_path,
                manufacturer: meta.manufacturer,
                product: meta.product,
            },
        );
    }

    out
}

pub fn build_persistent_audio_uid(
    host_name: &str,
    dev_name: &str,
    parsed: &ParsedAlsaSelector,
    card_info: Option<&AlsaCardUsbInfo>,
) -> String {
    if let Some(info) = card_info {
        if let (Some(vid), Some(pid)) = (info.usb_vid.as_deref(), info.usb_pid.as_deref()) {
            if let Some(serial) = info.usb_serial.as_deref().filter(|s| !s.is_empty()) {
                return format!(
                    "usb:{vid}:{pid}:{serial}:{}:{}",
                    parsed.pcm_prefix, parsed.dev_suffix
                );
            }
            if let Some(topo) = info.usb_topology_path.as_deref().filter(|s| !s.is_empty()) {
                return format!(
                    "usb-topo:{vid}:{pid}:{topo}:{}:{}",
                    parsed.pcm_prefix, parsed.dev_suffix
                );
            }
        }
    }

    format!("host:{host_name}:{dev_name}")
}

pub fn enumerate_audio_devices() -> Vec<AudioDeviceInfo> {
    let _open_guard = lock_audio_open();
    let cards = if cfg!(target_os = "linux") {
        scan_linux_sound_cards(Path::new("/sys/class/sound"))
    } else {
        HashMap::new()
    };

    let host = cpal::default_host();
    let host_name = host.id().name().to_string();
    let mut by_name: BTreeMap<String, AudioDeviceInfo> = BTreeMap::new();

    if let Ok(inputs) = host.input_devices() {
        for (idx, dev) in inputs.enumerate() {
            let name = dev.name().unwrap_or_else(|_| format!("Input #{idx}"));
            let mut max_in = 0_u16;
            let mut supports_48k = false;
            let mut default_rate = None;

            if let Ok(cfg) = dev.default_input_config() {
                max_in = cfg.channels();
                default_rate = Some(cfg.sample_rate().0);
            }
            if let Ok(ranges) = dev.supported_input_configs() {
                for r in ranges {
                    max_in = max_in.max(r.channels());
                    if r.min_sample_rate().0 <= 48_000 && r.max_sample_rate().0 >= 48_000 {
                        supports_48k = true;
                    }
                }
            }

            let parsed = parse_alsa_card_selector(&name);
            let card_info = parsed.card_id.as_deref().and_then(|cid| cards.get(cid));
            let device_uid = build_persistent_audio_uid(&host_name, &name, &parsed, card_info);

            let entry = by_name
                .entry(name.clone())
                .or_insert_with(|| AudioDeviceInfo {
                    index: idx,
                    name,
                    supports_input: false,
                    supports_output: false,
                    max_input_channels: 0,
                    max_output_channels: 0,
                    supports_48khz: false,
                    default_sample_rate: None,
                    host_name: host_name.clone(),
                    device_uid,
                    card_id: parsed.card_id,
                    usb_vid: card_info.and_then(|c| c.usb_vid.clone()),
                    usb_pid: card_info.and_then(|c| c.usb_pid.clone()),
                    usb_serial: card_info.and_then(|c| c.usb_serial.clone()),
                    usb_topology_path: card_info.and_then(|c| c.usb_topology_path.clone()),
                    manufacturer: card_info.and_then(|c| c.manufacturer.clone()),
                    product: card_info.and_then(|c| c.product.clone()),
                });
            entry.supports_input = true;
            entry.max_input_channels = entry.max_input_channels.max(max_in);
            entry.supports_48khz |= supports_48k;
            if entry.default_sample_rate.is_none() {
                entry.default_sample_rate = default_rate;
            }
        }
    }

    if let Ok(outputs) = host.output_devices() {
        for (idx, dev) in outputs.enumerate() {
            let name = dev.name().unwrap_or_else(|_| format!("Output #{idx}"));
            let mut max_out = 0_u16;
            let mut supports_48k = false;
            let mut default_rate = None;

            if let Ok(cfg) = dev.default_output_config() {
                max_out = cfg.channels();
                default_rate = Some(cfg.sample_rate().0);
            }
            if let Ok(ranges) = dev.supported_output_configs() {
                for r in ranges {
                    max_out = max_out.max(r.channels());
                    if r.min_sample_rate().0 <= 48_000 && r.max_sample_rate().0 >= 48_000 {
                        supports_48k = true;
                    }
                }
            }

            let parsed = parse_alsa_card_selector(&name);
            let card_info = parsed.card_id.as_deref().and_then(|cid| cards.get(cid));
            let device_uid = build_persistent_audio_uid(&host_name, &name, &parsed, card_info);

            let entry = by_name
                .entry(name.clone())
                .or_insert_with(|| AudioDeviceInfo {
                    index: idx,
                    name,
                    supports_input: false,
                    supports_output: false,
                    max_input_channels: 0,
                    max_output_channels: 0,
                    supports_48khz: false,
                    default_sample_rate: None,
                    host_name: host_name.clone(),
                    device_uid,
                    card_id: parsed.card_id,
                    usb_vid: card_info.and_then(|c| c.usb_vid.clone()),
                    usb_pid: card_info.and_then(|c| c.usb_pid.clone()),
                    usb_serial: card_info.and_then(|c| c.usb_serial.clone()),
                    usb_topology_path: card_info.and_then(|c| c.usb_topology_path.clone()),
                    manufacturer: card_info.and_then(|c| c.manufacturer.clone()),
                    product: card_info.and_then(|c| c.product.clone()),
                });
            entry.supports_output = true;
            entry.max_output_channels = entry.max_output_channels.max(max_out);
            entry.supports_48khz |= supports_48k;
            if entry.default_sample_rate.is_none() {
                entry.default_sample_rate = default_rate;
            }
        }
    }

    by_name
        .into_values()
        .enumerate()
        .map(|(i, mut d)| {
            d.index = i;
            d
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AudioMatchOutcome {
    ExactUid(AudioDeviceInfo),
    UsbFallback {
        device: AudioDeviceInfo,
        warning: String,
    },
    NameFallback {
        device: AudioDeviceInfo,
        warning: String,
    },
    NotFound,
}

/// Match saved audio UID / device name against live enumerated audio interfaces.
/// Precedence:
/// 1. Exact persistent `device_uid`.
/// 2. Parsed USB serial / topology prefix match when card number/prefix shifted.
/// 3. Exact device `name` fallback (with non-fatal WARN).
pub fn match_audio_device(
    saved_uid: Option<&str>,
    saved_name: Option<&str>,
    available: &[AudioDeviceInfo],
) -> AudioMatchOutcome {
    if let Some(uid) = saved_uid.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(exact) = available.iter().find(|d| d.device_uid == uid) {
            return AudioMatchOutcome::ExactUid(exact.clone());
        }

        // Fallback on matching VID:PID:SERIAL across differing ALSA prefixes
        if let Some(rest) = uid.strip_prefix("usb:") {
            let parts: Vec<&str> = rest.split(':').collect();
            if parts.len() >= 3 {
                let (vid, pid, serial) = (parts[0], parts[1], parts[2]);
                if let Some(usb_hit) = available.iter().find(|d| {
                    d.usb_vid.as_deref() == Some(vid)
                        && d.usb_pid.as_deref() == Some(pid)
                        && d.usb_serial.as_deref() == Some(serial)
                }) {
                    return AudioMatchOutcome::UsbFallback {
                        device: usb_hit.clone(),
                        warning: format!(
                            "Audio device matched by USB serial {vid}:{pid}:{serial} -> {}",
                            usb_hit.name
                        ),
                    };
                }
            }
        } else if let Some(rest) = uid.strip_prefix("usb-topo:") {
            let parts: Vec<&str> = rest.split(':').collect();
            if parts.len() >= 3 {
                let (vid, pid, topo) = (parts[0], parts[1], parts[2]);
                if let Some(topo_hit) = available.iter().find(|d| {
                    d.usb_vid.as_deref() == Some(vid)
                        && d.usb_pid.as_deref() == Some(pid)
                        && d.usb_topology_path.as_deref() == Some(topo)
                }) {
                    return AudioMatchOutcome::UsbFallback {
                        device: topo_hit.clone(),
                        warning: format!(
                            "Audio device matched by USB port topology {topo} -> {}",
                            topo_hit.name
                        ),
                    };
                }
            }
        }
    }

    if let Some(name) = saved_name.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(exact_name) = available.iter().find(|d| d.name == name) {
            return AudioMatchOutcome::NameFallback {
                device: exact_name.clone(),
                warning: format!(
                    "Audio device '{name}' matched by name fallback (persistent USB UID differed)"
                ),
            };
        }
    }

    AudioMatchOutcome::NotFound
}

pub fn resolve_cpal_input_device(target_name: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if let Ok(devs) = host.input_devices() {
        for dev in devs {
            if dev.name().ok().as_deref() == Some(target_name) {
                return Some(dev);
            }
        }
    }
    None
}

pub fn resolve_cpal_output_device(target_name: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if let Ok(devs) = host.output_devices() {
        for dev in devs {
            if dev.name().ok().as_deref() == Some(target_name) {
                return Some(dev);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    #[test]
    fn parses_alsa_card_and_device_selectors() {
        let p = parse_alsa_card_selector("plughw:CARD=CODEC,DEV=0");
        assert_eq!(p.pcm_prefix, "plughw");
        assert_eq!(p.card_id.as_deref(), Some("CODEC"));
        assert_eq!(p.dev_suffix, "dev0");

        let p2 = parse_alsa_card_selector("sysdefault:CARD=PCH");
        assert_eq!(p2.pcm_prefix, "sysdefault");
        assert_eq!(p2.card_id.as_deref(), Some("PCH"));
        assert_eq!(p2.dev_suffix, "default");
    }

    #[test]
    fn scans_sysfs_sound_card_usb_topology_metadata() {
        let root = tempdir().unwrap();
        let usb_dev = root.path().join("devices/pci0/usb3/3-2/3-2.4");
        let iface = usb_dev.join("3-2.4:1.0");
        fs::create_dir_all(&iface).unwrap();
        fs::write(usb_dev.join("idVendor"), "08bb\n").unwrap();
        fs::write(usb_dev.join("idProduct"), "2901\n").unwrap();
        fs::write(usb_dev.join("product"), "USB Audio CODEC\n").unwrap();

        let sound_dir = root.path().join("class_sound");
        let card3 = sound_dir.join("card3");
        fs::create_dir_all(&card3).unwrap();
        fs::write(card3.join("id"), "CODEC\n").unwrap();
        symlink(&iface, card3.join("device")).unwrap();

        let cards = scan_linux_sound_cards(&sound_dir);
        let codec = cards.get("CODEC").expect("CODEC card missing");
        assert_eq!(codec.usb_vid.as_deref(), Some("08bb"));
        assert_eq!(codec.usb_pid.as_deref(), Some("2901"));
        assert_eq!(codec.usb_topology_path.as_deref(), Some("3-2.4"));

        let parsed = parse_alsa_card_selector("plughw:CARD=CODEC,DEV=0");
        let uid =
            build_persistent_audio_uid("ALSA", "plughw:CARD=CODEC,DEV=0", &parsed, Some(codec));
        assert_eq!(uid, "usb-topo:08bb:2901:3-2.4:plughw:dev0");
    }

    #[test]
    fn matches_audio_device_with_precedence_and_name_fallback() {
        let dev = AudioDeviceInfo {
            index: 0,
            name: "plughw:CARD=CODEC,DEV=0".to_string(),
            supports_input: true,
            supports_output: true,
            max_input_channels: 2,
            max_output_channels: 2,
            supports_48khz: true,
            default_sample_rate: Some(48_000),
            host_name: "ALSA".to_string(),
            device_uid: "usb-topo:08bb:2901:3-2.4:plughw:dev0".to_string(),
            card_id: Some("CODEC".to_string()),
            usb_vid: Some("08bb".to_string()),
            usb_pid: Some("2901".to_string()),
            usb_serial: None,
            usb_topology_path: Some("3-2.4".to_string()),
            manufacturer: Some("TI".to_string()),
            product: Some("USB Audio CODEC".to_string()),
        };

        assert!(matches!(
            match_audio_device(
                Some(&dev.device_uid),
                Some(&dev.name),
                std::slice::from_ref(&dev)
            ),
            AudioMatchOutcome::ExactUid(_)
        ));
        assert!(matches!(
            match_audio_device(
                Some("usb-topo:08bb:2901:3-2.4:hw:dev0"),
                Some(&dev.name),
                std::slice::from_ref(&dev)
            ),
            AudioMatchOutcome::UsbFallback { .. }
        ));
        assert!(matches!(
            match_audio_device(
                Some("host:Other:plughw:CARD=CODEC,DEV=0"),
                Some(&dev.name),
                std::slice::from_ref(&dev)
            ),
            AudioMatchOutcome::NameFallback { .. }
        ));
        assert_eq!(
            match_audio_device(Some("missing"), Some("missing"), &[dev]),
            AudioMatchOutcome::NotFound
        );
    }
}
