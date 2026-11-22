use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "digi-dx",
    version,
    about = "Digi-Dx v2 — Single-process local FT8 operating daemon"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Start the Digi-Dx HTTP/WebSocket daemon and embedded LAN Web UI
    Serve(ServeArgs),
    /// Run system dependency, permissions, audio, and SQLite preflight checks
    Preflight(PreflightArgs),
    /// Query a running Digi-Dx daemon's health and preflight summary
    Status(StatusArgs),
}

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// IP/interface to bind HTTP & WebSocket server to
    #[arg(long, env = "DIGI_DX_BIND", default_value = "0.0.0.0")]
    pub bind: String,

    /// TCP port to listen on
    #[arg(long, env = "DIGI_DX_PORT", default_value_t = 8788)]
    pub port: u16,

    /// Persistent data directory for SQLite database
    #[arg(long, env = "DIGI_DX_DATA_DIR")]
    pub data_dir: Option<PathBuf>,

    /// Optional static bearer token protecting mutating LAN commands
    #[arg(long, env = "DIGI_DX_AUTH_TOKEN")]
    pub auth_token: Option<String>,
}

#[derive(Debug, Args)]
pub struct PreflightArgs {
    /// Output machine-readable JSON report
    #[arg(long)]
    pub json: bool,

    /// Exit with non-zero status if any FATAL check fails
    #[arg(long)]
    pub fail_on_fatal: bool,

    /// Attempt to open default audio stream parameters to verify capture/playback permissions
    #[arg(long)]
    pub probe_audio: bool,

    /// Persistent data directory for SQLite storage check
    #[arg(long, env = "DIGI_DX_DATA_DIR")]
    pub data_dir: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct StatusArgs {
    /// Base URL of a running Digi-Dx daemon
    #[arg(long, default_value = "http://127.0.0.1:8788")]
    pub url: String,

    /// Print raw JSON status payload
    #[arg(long)]
    pub json: bool,
}
