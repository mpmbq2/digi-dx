use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const DEFAULT_SLOT_MS: i64 = 15_000;
pub const FT4_SLOT_MS: i64 = 7_500;
pub const MIN_WALL_FLOOR_MS: i64 = 50;
pub const PRE_ARM_VIRTUAL_MS: i64 = 2_000;

/// Strongly typed UTC Unix timestamp in whole seconds (never milliseconds).
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct UnixSecs(pub i64);

/// Strongly typed virtual clock timestamp in milliseconds.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct VirtualMs(pub i64);

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlotParity {
    Even,
    Odd,
}

impl SlotParity {
    pub fn from_unix_secs(secs: UnixSecs) -> Self {
        if secs.0.div_euclid(15).rem_euclid(2) == 0 {
            Self::Even
        } else {
            Self::Odd
        }
    }

    pub fn from_virtual_ms(virtual_ms: i64, slot_ms: i64) -> Self {
        let step = slot_ms.max(1);
        if virtual_ms.div_euclid(step).rem_euclid(2) == 0 {
            Self::Even
        } else {
            Self::Odd
        }
    }

    pub fn opposite(self) -> Self {
        match self {
            Self::Even => Self::Odd,
            Self::Odd => Self::Even,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Even => "even",
            Self::Odd => "odd",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlotClockSpec {
    pub epoch_ms: i64,
    pub anchor_wall_ms: i64,
    pub slot_ms: i64,
    pub scale: f64,
}

impl SlotClockSpec {
    pub fn realtime(now_wall_ms: i64) -> Self {
        Self {
            epoch_ms: now_wall_ms,
            anchor_wall_ms: now_wall_ms,
            slot_ms: DEFAULT_SLOT_MS,
            scale: 1.0,
        }
    }
}

#[derive(Debug, Error, PartialEq)]
pub enum ClockError {
    #[error("slot_ms must be positive (got {0})")]
    InvalidSlotMs(i64),
    #[error("clock scale {scale} exceeds max safe scale {max_scale:.2} for {min_floor_ms}ms wall delay floor")]
    InvalidScale {
        scale: f64,
        max_scale: f64,
        min_floor_ms: i64,
    },
}

#[derive(Debug, Clone)]
pub struct SlotClock {
    spec: SlotClockSpec,
}

impl SlotClock {
    pub fn new(spec: SlotClockSpec) -> Result<Self, ClockError> {
        if spec.slot_ms <= 0 {
            return Err(ClockError::InvalidSlotMs(spec.slot_ms));
        }
        let max_scale = (spec.slot_ms as f64) / (2.0 * MIN_WALL_FLOOR_MS as f64);
        if !spec.scale.is_finite() || spec.scale <= 0.0 || spec.scale > max_scale {
            return Err(ClockError::InvalidScale {
                scale: spec.scale,
                max_scale,
                min_floor_ms: MIN_WALL_FLOOR_MS,
            });
        }
        Ok(Self { spec })
    }

    pub fn spec(&self) -> &SlotClockSpec {
        &self.spec
    }

    pub fn virtual_ms_at(&self, wall_ms: i64) -> VirtualMs {
        let elapsed_wall = wall_ms - self.spec.anchor_wall_ms;
        let elapsed_virtual = ((elapsed_wall as f64) * self.spec.scale).round() as i64;
        VirtualMs(self.spec.epoch_ms + elapsed_virtual)
    }

    pub fn unix_secs_at(&self, wall_ms: i64) -> UnixSecs {
        UnixSecs(self.virtual_ms_at(wall_ms).0.div_euclid(1000))
    }

    pub fn parity_at(&self, wall_ms: i64) -> SlotParity {
        SlotParity::from_virtual_ms(self.virtual_ms_at(wall_ms).0, self.spec.slot_ms)
    }

    pub fn ms_into_slot_virtual(&self, wall_ms: i64) -> i64 {
        self.virtual_ms_at(wall_ms).0.rem_euclid(self.spec.slot_ms)
    }

    pub fn ms_until_next_slot_wall(&self, wall_ms: i64) -> i64 {
        let rem_virtual = self.spec.slot_ms - self.ms_into_slot_virtual(wall_ms);
        ((rem_virtual as f64) / self.spec.scale).ceil() as i64
    }

    /// Wall delay (ms) until the pre-arm instant (2 virtual seconds before next slot boundary),
    /// floored at MIN_WALL_FLOOR_MS (50ms).
    pub fn pre_arm_delay_ms(&self, wall_ms: i64) -> i64 {
        let rem_virtual = self.spec.slot_ms - self.ms_into_slot_virtual(wall_ms);
        let until_arm_virtual = (rem_virtual - PRE_ARM_VIRTUAL_MS).max(0);
        let wall_delay = ((until_arm_virtual as f64) / self.spec.scale).ceil() as i64;
        wall_delay.max(MIN_WALL_FLOOR_MS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_derivation_uses_15s_utc_slots() {
        assert_eq!(SlotParity::from_unix_secs(UnixSecs(0)), SlotParity::Even);
        assert_eq!(SlotParity::from_unix_secs(UnixSecs(14)), SlotParity::Even);
        assert_eq!(SlotParity::from_unix_secs(UnixSecs(15)), SlotParity::Odd);
        assert_eq!(SlotParity::from_unix_secs(UnixSecs(29)), SlotParity::Odd);
        assert_eq!(SlotParity::from_unix_secs(UnixSecs(30)), SlotParity::Even);
        assert_eq!(SlotParity::Even.opposite(), SlotParity::Odd);
    }

    #[test]
    fn clock_scale_1_and_20_are_valid_and_respect_floor() {
        let rt = SlotClock::new(SlotClockSpec::realtime(1_795_212_900_000)).unwrap();
        assert_eq!(rt.parity_at(1_795_212_900_000), SlotParity::Even);
        assert_eq!(rt.ms_until_next_slot_wall(1_795_212_900_000), 15_000);
        assert_eq!(rt.pre_arm_delay_ms(1_795_212_900_000), 13_000);
        // At 14.99s into slot, pre_arm_delay_ms floors at 50ms.
        assert_eq!(rt.pre_arm_delay_ms(1_795_212_914_990), MIN_WALL_FLOOR_MS);

        let fast = SlotClock::new(SlotClockSpec {
            epoch_ms: 0,
            anchor_wall_ms: 1_000,
            slot_ms: 15_000,
            scale: 20.0,
        })
        .unwrap();
        // 750ms wall == 15_000ms virtual -> flips to Odd
        assert_eq!(fast.parity_at(1_750), SlotParity::Odd);
        // Pre-arm at t=0: (15000 - 2000) / 20 = 650ms wall
        assert_eq!(fast.pre_arm_delay_ms(1_000), 650);
    }

    #[test]
    fn clock_rejects_excessive_scale_and_non_positive_values() {
        // Max scale for 15_000ms with 50ms floor is 15000 / 100 = 150.0
        let too_fast = SlotClock::new(SlotClockSpec {
            epoch_ms: 0,
            anchor_wall_ms: 0,
            slot_ms: 15_000,
            scale: 151.0,
        });
        assert!(matches!(too_fast, Err(ClockError::InvalidScale { .. })));

        let zero_scale = SlotClock::new(SlotClockSpec {
            epoch_ms: 0,
            anchor_wall_ms: 0,
            slot_ms: 15_000,
            scale: 0.0,
        });
        assert!(matches!(zero_scale, Err(ClockError::InvalidScale { .. })));

        let bad_slot = SlotClock::new(SlotClockSpec {
            epoch_ms: 0,
            anchor_wall_ms: 0,
            slot_ms: 0,
            scale: 1.0,
        });
        assert_eq!(bad_slot.unwrap_err(), ClockError::InvalidSlotMs(0));
    }

    #[test]
    fn ft4_7_5s_parity_alternates_every_7500ms() {
        assert_eq!(
            SlotParity::from_virtual_ms(0, FT4_SLOT_MS),
            SlotParity::Even
        );
        assert_eq!(
            SlotParity::from_virtual_ms(7_499, FT4_SLOT_MS),
            SlotParity::Even
        );
        assert_eq!(
            SlotParity::from_virtual_ms(7_500, FT4_SLOT_MS),
            SlotParity::Odd
        );
        assert_eq!(
            SlotParity::from_virtual_ms(14_999, FT4_SLOT_MS),
            SlotParity::Odd
        );
        assert_eq!(
            SlotParity::from_virtual_ms(15_000, FT4_SLOT_MS),
            SlotParity::Even
        );

        let ft4_clock = SlotClock::new(SlotClockSpec {
            epoch_ms: 0,
            anchor_wall_ms: 1_000,
            slot_ms: FT4_SLOT_MS,
            scale: 1.0,
        })
        .unwrap();
        assert_eq!(ft4_clock.parity_at(1_000), SlotParity::Even);
        assert_eq!(ft4_clock.parity_at(8_500), SlotParity::Odd);
        assert_eq!(ft4_clock.parity_at(16_000), SlotParity::Even);
    }
}
