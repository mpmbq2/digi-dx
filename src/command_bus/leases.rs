use std::collections::HashMap;
use std::sync::RwLock;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const LEASE_TTL_MS: i64 = 15_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlLease {
    pub radio_id: String,
    pub lease_id: String,
    pub holder_actor: String,
    pub acquired_at_utc: String,
    pub expires_at_utc: String,
    #[serde(skip)]
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseError {
    Required,
    HeldByOther { holder_actor: String },
    InvalidLeaseId,
}

#[derive(Debug, Default)]
pub struct ControlLeaseManager {
    leases: RwLock<HashMap<String, ControlLease>>,
}

impl ControlLeaseManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn claim(
        &self,
        radio_id: &str,
        actor: &str,
        force: bool,
    ) -> Result<ControlLease, LeaseError> {
        let now = Utc::now();
        let mut map = self.leases.write().expect("lease lock poisoned");
        Self::prune_expired_locked(&mut map, now);

        if let Some(existing) = map.get(radio_id) {
            if existing.holder_actor != actor && !force {
                return Err(LeaseError::HeldByOther {
                    holder_actor: existing.holder_actor.clone(),
                });
            }
        }

        let expires_at = now + Duration::milliseconds(LEASE_TTL_MS);
        let lease = ControlLease {
            radio_id: radio_id.to_string(),
            lease_id: Uuid::now_v7().to_string(),
            holder_actor: actor.to_string(),
            acquired_at_utc: format_ts(now),
            expires_at_utc: format_ts(expires_at),
            expires_at,
        };
        map.insert(radio_id.to_string(), lease.clone());
        Ok(lease)
    }

    pub fn heartbeat(
        &self,
        radio_id: &str,
        actor: &str,
        lease_id: &str,
    ) -> Result<ControlLease, LeaseError> {
        let now = Utc::now();
        let mut map = self.leases.write().expect("lease lock poisoned");
        Self::prune_expired_locked(&mut map, now);

        let lease = map.get_mut(radio_id).ok_or(LeaseError::Required)?;
        if lease.holder_actor != actor {
            return Err(LeaseError::HeldByOther {
                holder_actor: lease.holder_actor.clone(),
            });
        }
        if lease.lease_id != lease_id {
            return Err(LeaseError::InvalidLeaseId);
        }

        let expires_at = now + Duration::milliseconds(LEASE_TTL_MS);
        lease.expires_at = expires_at;
        lease.expires_at_utc = format_ts(expires_at);
        Ok(lease.clone())
    }

    pub fn release(&self, radio_id: &str, actor: &str) -> Result<(), LeaseError> {
        let now = Utc::now();
        let mut map = self.leases.write().expect("lease lock poisoned");
        Self::prune_expired_locked(&mut map, now);

        match map.get(radio_id) {
            None => Err(LeaseError::Required),
            Some(existing) if existing.holder_actor != actor => Err(LeaseError::HeldByOther {
                holder_actor: existing.holder_actor.clone(),
            }),
            Some(_) => {
                map.remove(radio_id);
                Ok(())
            }
        }
    }

    pub fn force_clear(&self, radio_id: &str) {
        let mut map = self.leases.write().expect("lease lock poisoned");
        map.remove(radio_id);
    }

    pub fn verify_holder(&self, radio_id: &str, actor: &str) -> Result<ControlLease, LeaseError> {
        let now = Utc::now();
        let mut map = self.leases.write().expect("lease lock poisoned");
        Self::prune_expired_locked(&mut map, now);

        match map.get(radio_id) {
            None => Err(LeaseError::Required),
            Some(existing) if existing.holder_actor != actor => Err(LeaseError::HeldByOther {
                holder_actor: existing.holder_actor.clone(),
            }),
            Some(existing) => Ok(existing.clone()),
        }
    }

    pub fn snapshot(&self) -> Vec<ControlLease> {
        let now = Utc::now();
        let mut map = self.leases.write().expect("lease lock poisoned");
        Self::prune_expired_locked(&mut map, now);
        map.values().cloned().collect()
    }

    fn prune_expired_locked(map: &mut HashMap<String, ControlLease>, now: DateTime<Utc>) {
        map.retain(|_, lease| lease.expires_at > now);
    }
}

fn format_ts(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
