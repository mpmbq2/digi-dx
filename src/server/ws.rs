use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

use crate::command_bus::CommandEnvelope;
use crate::server::routes::build_radio_summaries;
use crate::server::AppState;
use crate::store::now_utc_str;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WsClientFrame {
    Ping,
    Auth {
        token: String,
    },
    Command {
        envelope: CommandEnvelope,
        #[serde(default)]
        token: Option<String>,
    },
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(128);

    // Send immediate initial snapshot on connect
    let snapshot_json = build_snapshot(&state);
    if ws_sender
        .send(Message::Text(snapshot_json.into()))
        .await
        .is_err()
    {
        return;
    }

    let mut broadcast_rx = state.ws_tx.subscribe();
    let mut session_token: Option<String> = None;
    let mut seen_actors: HashSet<String> = HashSet::new();

    let writer_task = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if ws_sender.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    loop {
        tokio::select! {
            broadcast_msg = broadcast_rx.recv() => {
                match broadcast_msg {
                    Ok(ev) => {
                        if let Ok(serialized) = serde_json::to_string(&ev) {
                            if out_tx.send(serialized).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            inbound = ws_receiver.next() => {
                match inbound {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<WsClientFrame>(text.as_str()) {
                            Ok(WsClientFrame::Ping) => {
                                let pong = json!({
                                    "type": "pong",
                                    "server_time_utc": now_utc_str(),
                                });
                                let _ = out_tx.send(pong.to_string()).await;
                            }
                            Ok(WsClientFrame::Auth { token }) => {
                                let ok = state.bus.verify_token(Some(token.as_str()));
                                if ok {
                                    session_token = Some(token);
                                }
                                let reply = json!({
                                    "type": "auth_ack",
                                    "authenticated": ok,
                                });
                                let _ = out_tx.send(reply.to_string()).await;
                            }
                            Ok(WsClientFrame::Command { envelope, token }) => {
                                if !envelope.actor.trim().is_empty() {
                                    seen_actors.insert(envelope.actor.clone());
                                }
                                let effective_token = token
                                    .as_deref()
                                    .or(session_token.as_deref());
                                let ack = state.bus.dispatch(envelope, effective_token).await;
                                if let Ok(ack_json) = serde_json::to_string(&ack) {
                                    let _ = out_tx.send(ack_json).await;
                                }
                            }
                            Err(e) => {
                                let err_frame = json!({
                                    "type": "ws_error",
                                    "error_code": "VALIDATION_FAILED",
                                    "message": format!("Invalid WS client frame: {e}"),
                                });
                                let _ = out_tx.send(err_frame.to_string()).await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    for actor in seen_actors {
        state.watchdog.on_actor_disconnected(&actor).await;
    }

    writer_task.abort();
}

fn build_snapshot(state: &AppState) -> String {
    let station = state.store.get_station_config().ok();
    let preflight = state
        .preflight
        .read()
        .expect("preflight lock poisoned")
        .clone();
    let outbox_stats = state.store.outbox_stats(&state.sink_name).ok();
    let radios = build_radio_summaries(state).unwrap_or_default();
    let usb_devices = state.supervisor.list_usb_inventory().unwrap_or_default();
    let leases = state.bus.leases().snapshot();
    let session = state.sessions.snapshot();

    json!({
        "type": "snapshot",
        "server_version": env!("CARGO_PKG_VERSION"),
        "uptime_sec": state.started_at.elapsed().as_secs(),
        "auth_required": state.bus.auth_required(),
        "station": station,
        "slot_clock": session.slot_clock.clone(),
        "preflight": preflight,
        "outbox_stats": outbox_stats,
        "radios": radios,
        "usb_devices": usb_devices,
        "leases": leases,
        "session": session,
        "active_qsos": session.active_qsos,
        "recent_decodes": session.recent_decodes,
    })
    .to_string()
}
