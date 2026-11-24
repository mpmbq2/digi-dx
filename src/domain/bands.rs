/// Amateur radio band entry in Hz (lower-inclusive, upper-exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BandDef {
    pub name: &'static str,
    pub min_hz: u64,
    pub max_hz: u64,
    pub standard_ft8_hz: Option<u64>,
    pub standard_ft4_hz: Option<u64>,
}

pub const AMATEUR_BANDS: &[BandDef] = &[
    BandDef {
        name: "160m",
        min_hz: 1_800_000,
        max_hz: 2_000_000,
        standard_ft8_hz: Some(1_840_000),
        standard_ft4_hz: None,
    },
    BandDef {
        name: "80m",
        min_hz: 3_500_000,
        max_hz: 4_000_000,
        standard_ft8_hz: Some(3_573_000),
        standard_ft4_hz: Some(3_575_000),
    },
    BandDef {
        name: "60m",
        min_hz: 5_060_000,
        max_hz: 5_450_000,
        standard_ft8_hz: Some(5_357_000),
        standard_ft4_hz: None,
    },
    BandDef {
        name: "40m",
        min_hz: 7_000_000,
        max_hz: 7_300_000,
        standard_ft8_hz: Some(7_074_000),
        standard_ft4_hz: Some(7_047_500),
    },
    BandDef {
        name: "30m",
        min_hz: 10_100_000,
        max_hz: 10_150_000,
        standard_ft8_hz: Some(10_136_000),
        standard_ft4_hz: Some(10_140_000),
    },
    BandDef {
        name: "20m",
        min_hz: 14_000_000,
        max_hz: 14_350_000,
        standard_ft8_hz: Some(14_074_000),
        standard_ft4_hz: Some(14_080_000),
    },
    BandDef {
        name: "17m",
        min_hz: 18_068_000,
        max_hz: 18_168_000,
        standard_ft8_hz: Some(18_100_000),
        standard_ft4_hz: Some(18_104_000),
    },
    BandDef {
        name: "15m",
        min_hz: 21_000_000,
        max_hz: 21_450_000,
        standard_ft8_hz: Some(21_074_000),
        standard_ft4_hz: Some(21_140_000),
    },
    BandDef {
        name: "12m",
        min_hz: 24_890_000,
        max_hz: 24_990_000,
        standard_ft8_hz: Some(24_915_000),
        standard_ft4_hz: Some(24_919_000),
    },
    BandDef {
        name: "10m",
        min_hz: 28_000_000,
        max_hz: 29_700_000,
        standard_ft8_hz: Some(28_074_000),
        standard_ft4_hz: Some(28_180_000),
    },
    BandDef {
        name: "6m",
        min_hz: 50_000_000,
        max_hz: 54_000_000,
        standard_ft8_hz: Some(50_313_000),
        standard_ft4_hz: Some(50_318_000),
    },
    BandDef {
        name: "2m",
        min_hz: 144_000_000,
        max_hz: 148_000_000,
        standard_ft8_hz: Some(144_174_000),
        standard_ft4_hz: None,
    },
    BandDef {
        name: "1.25m",
        min_hz: 222_000_000,
        max_hz: 225_000_000,
        standard_ft8_hz: None,
        standard_ft4_hz: None,
    },
    BandDef {
        name: "70cm",
        min_hz: 420_000_000,
        max_hz: 450_000_000,
        standard_ft8_hz: Some(432_174_000),
        standard_ft4_hz: None,
    },
];

/// Derive ADIF band name from frequency in Hz (lower-inclusive, upper-exclusive).
pub fn derive_band(freq_hz: u64) -> Option<&'static str> {
    AMATEUR_BANDS
        .iter()
        .find(|b| freq_hz >= b.min_hz && freq_hz < b.max_hz)
        .map(|b| b.name)
}

pub fn standard_ft8_dial_hz(band: &str) -> Option<u64> {
    AMATEUR_BANDS
        .iter()
        .find(|b| b.name.eq_ignore_ascii_case(band))
        .and_then(|b| b.standard_ft8_hz)
}

pub fn standard_ft4_dial_hz(band: &str) -> Option<u64> {
    AMATEUR_BANDS
        .iter()
        .find(|b| b.name.eq_ignore_ascii_case(band))
        .and_then(|b| b.standard_ft4_hz)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_all_bands_lower_inclusive_upper_exclusive() {
        assert_eq!(derive_band(1_800_000), Some("160m"));
        assert_eq!(derive_band(1_999_999), Some("160m"));
        assert_eq!(derive_band(2_000_000), None);
        assert_eq!(derive_band(3_573_000), Some("80m"));
        assert_eq!(derive_band(5_357_000), Some("60m"));
        assert_eq!(derive_band(7_074_000), Some("40m"));
        assert_eq!(derive_band(10_136_000), Some("30m"));
        assert_eq!(derive_band(14_074_000), Some("20m"));
        assert_eq!(derive_band(14_350_000), None);
        assert_eq!(derive_band(18_100_000), Some("17m"));
        assert_eq!(derive_band(21_074_000), Some("15m"));
        assert_eq!(derive_band(24_915_000), Some("12m"));
        assert_eq!(derive_band(28_074_000), Some("10m"));
        assert_eq!(derive_band(50_313_000), Some("6m"));
        assert_eq!(derive_band(144_174_000), Some("2m"));
        assert_eq!(derive_band(222_100_000), Some("1.25m"));
        assert_eq!(derive_band(432_174_000), Some("70cm"));
        assert_eq!(derive_band(450_000_000), None);
    }

    #[test]
    fn returns_standard_ft8_dial_frequencies() {
        assert_eq!(standard_ft8_dial_hz("20m"), Some(14_074_000));
        assert_eq!(standard_ft8_dial_hz("1.25m"), None);
    }

    #[test]
    fn returns_standard_ft4_dial_frequencies() {
        assert_eq!(standard_ft4_dial_hz("20m"), Some(14_080_000));
        assert_eq!(standard_ft4_dial_hz("40m"), Some(7_047_500));
        assert_eq!(standard_ft4_dial_hz("160m"), None);
        assert_eq!(standard_ft4_dial_hz("2m"), None);
    }
}
