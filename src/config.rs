use std::env;
use std::path::PathBuf;

use crate::cli::ServeArgs;

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub bind: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub auth_token: Option<String>,
    pub rigctl_path: Option<PathBuf>,
    pub rigctld_path: Option<PathBuf>,
    pub jt9_path: Option<PathBuf>,
    pub gcp_telemetry_enabled: bool,
    pub gcp_bridge_enabled: bool,
    pub gcp_project_id: Option<String>,
    pub gcp_topic_id: Option<String>,
    pub gcp_credentials_path: Option<PathBuf>,
    pub outbox_max_rows: usize,
    pub outbox_retention_days: i64,
    pub qrz_api_key: Option<String>,
    pub qrz_api_url: String,
}

impl DaemonConfig {
    pub fn from_serve_args(args: &ServeArgs) -> Self {
        let data_dir = args
            .data_dir
            .clone()
            .or_else(|| env_path("DIGI_DX_DATA_DIR"))
            .unwrap_or_else(default_data_dir);

        let auth_token = args
            .auth_token
            .clone()
            .or_else(|| env::var("DIGI_DX_AUTH_TOKEN").ok())
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        Self {
            bind: args.bind.clone(),
            port: args.port,
            data_dir,
            auth_token,
            rigctl_path: env_path("DIGI_DX_RIGCTL_PATH"),
            rigctld_path: env_path("DIGI_DX_RIGCTLD_PATH"),
            jt9_path: env_path("DIGI_DX_JT9_PATH"),
            gcp_telemetry_enabled: env_bool("DIGI_DX_GCP_TELEMETRY_ENABLED", false),
            gcp_bridge_enabled: env_bool("DIGI_DX_GCP_BRIDGE_ENABLED", false),
            gcp_project_id: env_nonempty("DIGI_DX_GCP_PROJECT_ID"),
            gcp_topic_id: env_nonempty("DIGI_DX_GCP_TOPIC_ID"),
            gcp_credentials_path: env_path("DIGI_DX_GCP_CREDENTIALS_PATH"),
            outbox_max_rows: env::var("DIGI_DX_OUTBOX_MAX_ROWS")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|&v| v > 0)
                .unwrap_or(50_000),
            outbox_retention_days: env::var("DIGI_DX_OUTBOX_RETENTION_DAYS")
                .ok()
                .and_then(|v| v.parse::<i64>().ok())
                .filter(|&v| v > 0)
                .unwrap_or(14),
            qrz_api_key: env_nonempty("DIGI_DX_QRZ_API_KEY"),
            qrz_api_url: env_nonempty("DIGI_DX_QRZ_API_URL")
                .unwrap_or_else(|| "https://logbook.qrz.com/api".to_string()),
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("digi-dx.db")
    }
}

pub fn default_data_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("digi-dx");
        }
        return PathBuf::from("/tmp/digi-dx");
    }

    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(unix)]
        {
            // SAFETY: geteuid has no preconditions and returns the effective UID.
            if unsafe { libc::geteuid() } == 0 {
                return PathBuf::from("/var/lib/digi-dx");
            }
        }
        if let Ok(xdg) = env::var("XDG_DATA_HOME") {
            let trimmed = xdg.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("digi-dx");
            }
        }
        if let Ok(home) = env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("digi-dx");
        }
        PathBuf::from("/var/lib/digi-dx")
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_path(key: &str) -> Option<PathBuf> {
    env_nonempty(key).map(PathBuf::from)
}

fn env_bool(key: &str, default: bool) -> bool {
    match env_nonempty(key) {
        Some(v) => matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        None => default,
    }
}
