use std::sync::Arc;

use async_trait::async_trait;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::command_bus::{CommandAck, CommandBus, CommandEnvelope, CommandOrigin};

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("transport disabled")]
    Disabled,
    #[error("transport I/O error: {0}")]
    Io(String),
}

#[async_trait]
pub trait CommandTransport: Send + Sync {
    fn origin(&self) -> CommandOrigin;
    async fn run(
        &self,
        bus: Arc<CommandBus>,
        shutdown: CancellationToken,
    ) -> Result<(), TransportError>;
}

/// Outbound-initiated GCP remote-control bridge client (stubbed in MVP).
pub struct GcpBridgeClientStub {
    pub enabled: bool,
    pub endpoint: Option<String>,
}

impl GcpBridgeClientStub {
    pub fn new(enabled: bool, endpoint: Option<String>) -> Self {
        Self { enabled, endpoint }
    }

    /// Processes a single inbound command frame (usable by mock transport contract tests)
    /// forcing `origin = CommandOrigin::GcpBridge`.
    pub async fn dispatch_inbound_frame(
        &self,
        bus: &CommandBus,
        mut envelope: CommandEnvelope,
        presented_token: Option<&str>,
    ) -> CommandAck {
        envelope.origin = CommandOrigin::GcpBridge;
        bus.dispatch(envelope, presented_token).await
    }
}

#[async_trait]
impl CommandTransport for GcpBridgeClientStub {
    fn origin(&self) -> CommandOrigin {
        CommandOrigin::GcpBridge
    }

    async fn run(
        &self,
        _bus: Arc<CommandBus>,
        shutdown: CancellationToken,
    ) -> Result<(), TransportError> {
        if !self.enabled {
            shutdown.cancelled().await;
            return Ok(());
        }
        Err(TransportError::Disabled)
    }
}
