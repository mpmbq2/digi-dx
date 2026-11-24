import type { ActiveQso, CqState } from "../../types";
import type { DigitalMode, FeedSection, SwimlaneStage } from "./types";

export const WF_MIN_HZ = 200;
export const WF_MAX_HZ = 3000;

export const QSO_PALETTE = [
  "#38bdf8", // Q1 Cyan
  "#f59e0b", // Q2 Amber
  "#e879f9", // Q3 Magenta
  "#34d399", // Q4 Emerald
  "#a78bfa", // Q5 Violet
  "#fb7185", // Q6 Coral
] as const;

export interface SubbandPreset {
  band: string;
  ft8Hz: number;
  ft4Hz: number | null;
}

export const SUBBAND_PRESETS: SubbandPreset[] = [
  { band: "160m", ft8Hz: 1_840_000, ft4Hz: null },
  { band: "80m", ft8Hz: 3_573_000, ft4Hz: 3_575_000 },
  { band: "60m", ft8Hz: 5_357_000, ft4Hz: null },
  { band: "40m", ft8Hz: 7_074_000, ft4Hz: 7_047_500 },
  { band: "30m", ft8Hz: 10_136_000, ft4Hz: 10_140_000 },
  { band: "20m", ft8Hz: 14_074_000, ft4Hz: 14_080_000 },
  { band: "17m", ft8Hz: 18_100_000, ft4Hz: 18_104_000 },
  { band: "15m", ft8Hz: 21_074_000, ft4Hz: 21_140_000 },
  { band: "12m", ft8Hz: 24_915_000, ft4Hz: 24_919_000 },
  { band: "10m", ft8Hz: 28_074_000, ft4Hz: 28_180_000 },
  { band: "6m", ft8Hz: 50_313_000, ft4Hz: 50_318_000 },
];

export function getSubbandFreq(band: string, mode: DigitalMode): number | null {
  const entry = SUBBAND_PRESETS.find((b) => b.band === band);
  if (!entry) return null;
  if (mode === "FT4") {
    return entry.ft4Hz ?? entry.ft8Hz;
  }
  return entry.ft8Hz;
}

export function normalizeCall(callsign: string | null | undefined): string {
  if (!callsign) return "";
  return callsign.replace(/[<>]/g, "").trim().toUpperCase();
}

export function getBaseCall(callsign: string | null | undefined): string {
  const raw = normalizeCall(callsign);
  if (!raw) return "";
  if (!raw.includes("/")) return raw;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length < 2) return parts[0] || raw;
  const suffixes = new Set(["P", "M", "QRP", "MM", "AM", "B", "A", "LH", "KT"]);
  if (parts[1].includes("-") || suffixes.has(parts[1]) || parts[1].length <= 2) {
    return parts[0];
  }
  if (parts[0].length <= 3 && parts[1].length >= 4) {
    return parts[1];
  }
  return parts[0];
}

export function qrzUrl(callsign: string): string {
  return `https://www.qrz.com/db/${encodeURIComponent(getBaseCall(callsign))}`;
}

export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return `rgba(56, 189, 248, ${alpha})`;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function fmtSnr(snr: number | null | undefined): string {
  if (snr === null || snr === undefined || Number.isNaN(snr)) return "--";
  const v = Math.round(snr);
  return `${v >= 0 ? "+" : "-"}${String(Math.abs(v)).padStart(2, "0")}`;
}

export function snrClass(snr: number | null | undefined): string {
  if (snr === null || snr === undefined) return "mft8-snr-mid";
  if (snr >= -4) return "mft8-snr-hi";
  if (snr >= -12) return "mft8-snr-mid";
  return "mft8-snr-lo";
}

export function fmtUtcFromSec(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(11, 19);
}

export function fmtDialMhz(freqHz: number | null | undefined): string {
  if (freqHz === null || freqHz === undefined || freqHz <= 0) return "—";
  return `${(freqHz / 1_000_000).toFixed(6)} MHz`;
}

export function classifyDecodeSection(
  message: string,
  myCall: string | null | undefined
): FeedSection {
  const trimmed = message.trim().toUpperCase();
  if (trimmed.startsWith("CQ ")) return "CQ";
  const cleanMy = normalizeCall(myCall);
  if (cleanMy) {
    const tokens = trimmed.split(/\s+/);
    if (tokens.length >= 2 && normalizeCall(tokens[0]) === cleanMy) {
      return "TARGETING_ME";
    }
  }
  return "TARGETING_OTHERS";
}

export function extractStationTags(
  callsign: string,
  message: string | null | undefined,
  distanceKm: number | null
): string[] {
  const tags: string[] = [];
  const upCall = normalizeCall(callsign);
  const upMsg = (message ?? "").toUpperCase();
  if (upMsg.includes("CQ SOTA ") || upCall.includes("SOTA")) {
    tags.push("SOTA");
  }
  if (upMsg.includes("CQ POTA ") || upCall.includes("POTA")) {
    tags.push("POTA");
  }
  if (upMsg.includes("CQ DX ") || (distanceKm !== null && distanceKm >= 3500)) {
    tags.push("DX");
  }
  return tags;
}

export function formatQsoNextTx(q: ActiveQso): string {
  const grid4 = (q.my_grid || "").slice(0, 4);
  const snrStr = fmtSnr(q.last_their_snr_db ?? -10);
  switch (q.step) {
    case "calling_cq":
      return q.directed_cq
        ? `CQ ${q.directed_cq} ${q.my_call} ${grid4}`.trim()
        : `CQ ${q.my_call} ${grid4}`.trim();
    case "send_grid":
      return `${q.their_call} ${q.my_call} ${grid4}`.trim();
    case "send_report":
      return `${q.their_call} ${q.my_call} ${snrStr}`;
    case "send_r_report":
      return `${q.their_call} ${q.my_call} R${snrStr}`;
    case "send_rr73":
      return `${q.their_call} ${q.my_call} RR73`;
    case "send_73":
    case "send73":
      return `${q.their_call} ${q.my_call} 73`;
    default:
      return `${q.their_call} ${q.my_call}`;
  }
}

export function formatCqMessage(
  cq: CqState,
  myCall: string | null | undefined,
  myGrid: string | null | undefined
): string {
  const call = normalizeCall(myCall) || "MYCALL";
  const grid4 = (myGrid || "").slice(0, 4).toUpperCase();
  const parts = ["CQ"];
  if (cq.directed_cq) parts.push(cq.directed_cq);
  parts.push(call);
  if (grid4) parts.push(grid4);
  return parts.join(" ");
}

export function resolveQsoRole(q: ActiveQso): "caller" | "hunter" {
  if (q.their_role === "caller" || q.their_role === "hunter") {
    return q.their_role;
  }
  return q.step === "send_grid" ? "caller" : "hunter";
}

export function mapActiveQsoToStage(q: ActiveQso): SwimlaneStage {
  const hasConfirmedTx =
    q.attempts_on_step > 0 ||
    (q.transcript ?? []).some((t) => t.direction === "tx");

  if (q.step === "send_grid") return 0;
  if (q.step === "send_report") {
    return hasConfirmedTx ? 1 : 0;
  }
  if (q.step === "send_r_report") {
    return resolveQsoRole(q) === "hunter" && !hasConfirmedTx ? 0 : 1;
  }
  if (q.step === "send_rr73" || q.step === "send_73" || q.step === "send73") {
    return 2;
  }
  return 0;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
