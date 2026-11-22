use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::ExitCode;
use std::time::Duration;

use clap::Parser;
use tracing_subscriber::EnvFilter;

use digi_dx::cli::{Cli, Command, PreflightArgs, ServeArgs, StatusArgs};
use digi_dx::config::{default_data_dir, DaemonConfig};
use digi_dx::preflight::{print_human_report, run_preflight};
use digi_dx::server::serve_daemon;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();

    let is_json_preflight = matches!(
        &cli.command,
        Command::Preflight(PreflightArgs { json: true, .. })
    );

    if !is_json_preflight || std::env::var_os("RUST_LOG").is_some() {
        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,digi_dx=info"));
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(std::io::stderr)
            .init();
    }

    match cli.command {
        Command::Serve(args) => {
            let config = DaemonConfig::from_serve_args(&args);
            if let Err(err) = serve_daemon(config).await {
                eprintln!("digi-dx serve failed: {err}");
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Command::Preflight(args) => run_preflight_cmd(args),
        Command::Status(args) => run_status_cmd(args),
    }
}

fn run_preflight_cmd(args: PreflightArgs) -> ExitCode {
    let mut cfg = DaemonConfig::from_serve_args(&ServeArgs {
        bind: "0.0.0.0".to_string(),
        port: 8788,
        data_dir: args.data_dir,
        auth_token: None,
    });
    if let Some(d) = std::env::var_os("DIGI_DX_DATA_DIR") {
        if cfg.data_dir == default_data_dir() && !d.is_empty() {
            cfg.data_dir = d.into();
        }
    }

    let report = run_preflight(&cfg, args.probe_audio);
    if args.json {
        match serde_json::to_string_pretty(&report) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                eprintln!("failed to serialize preflight report: {e}");
                return ExitCode::FAILURE;
            }
        }
    } else {
        print_human_report(&report);
    }

    if args.fail_on_fatal && report.has_fatal() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn run_status_cmd(args: StatusArgs) -> ExitCode {
    let stripped = args
        .url
        .trim()
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let host_port = stripped.split('/').next().unwrap_or("127.0.0.1:8788");

    match http_get_json(host_port, "/api/v1/health") {
        Ok(health_json) => {
            if args.json {
                println!("{health_json}");
            } else {
                println!("Digi-Dx daemon health ({}): {health_json}", args.url);
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Failed to reach Digi-Dx daemon at {}: {e}", args.url);
            ExitCode::FAILURE
        }
    }
}

fn http_get_json(host_port: &str, path: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(host_port).map_err(|e| e.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

    let req = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut raw = String::new();
    stream.read_to_string(&mut raw).map_err(|e| e.to_string())?;

    let Some((_, body)) = raw.split_once("\r\n\r\n") else {
        return Err("malformed HTTP response".to_string());
    };
    Ok(body.trim().to_string())
}
