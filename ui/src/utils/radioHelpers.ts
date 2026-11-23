export const FT8_BAND_PRESETS: Array<{ band: string; hz: number; mhz: string }> = [
  { band: "160m", hz: 1_840_000, mhz: "1.840" },
  { band: "80m", hz: 3_573_000, mhz: "3.573" },
  { band: "60m", hz: 5_357_000, mhz: "5.357" },
  { band: "40m", hz: 7_074_000, mhz: "7.074" },
  { band: "30m", hz: 10_136_000, mhz: "10.136" },
  { band: "20m", hz: 14_074_000, mhz: "14.074" },
  { band: "17m", hz: 18_100_000, mhz: "18.100" },
  { band: "15m", hz: 21_074_000, mhz: "21.074" },
  { band: "12m", hz: 24_915_000, mhz: "24.915" },
  { band: "10m", hz: 28_074_000, mhz: "28.074" },
  { band: "6m", hz: 50_313_000, mhz: "50.313" },
  { band: "2m", hz: 144_174_000, mhz: "144.174" },
];

export const POPULAR_MODEL_IDS = [1, 2016, 2031, 3073, 3085, 1035, 1042, 2045];

export const BAUD_RATES = [4800, 9600, 19200, 38400, 57600, 115200];

export function formatLifecycleLabel(state: string): string {
  switch (state) {
    case "POWERED_OFF":
      return "POWERED OFF";
    case "ACTIVE_SESSION":
      return "ACTIVE SESSION";
    case "STARTING_RIGCTLD":
      return "STARTING";
    default:
      return state;
  }
}

export function lifecycleBadgeClass(state: string): string {
  switch (state) {
    case "READY":
    case "ACTIVE_SESSION":
      return "badge-ok";
    case "POWERED_OFF":
    case "DISCONNECTED":
      return "badge-warn";
    case "STARTING_RIGCTLD":
    case "RECOVERING":
    case "CONFIGURED":
      return "badge-info";
    case "DEGRADED":
      return "badge-fail";
    case "UNCONFIGURED":
      return "badge-muted";
    default:
      return "badge-warn";
  }
}

export function formatFreqMhz(freqHz: number | null | undefined): string {
  if (freqHz === null || freqHz === undefined || freqHz <= 0) return "—";
  return `${(freqHz / 1_000_000).toFixed(6)} MHz`;
}
