export type DigitalMode = "FT8" | "FT4";

export type SwimlaneStage = 0 | 1 | 2 | 3;

export type FeedSection = "TARGETING_ME" | "CQ" | "TARGETING_OTHERS";

export type RosterFilter = "all" | "cq" | "sotapota" | "inqso";

export type RosterSortPreset =
  | "fresh_dist"
  | "strict_dist"
  | "snr_desc"
  | "dist_desc"
  | "freq_asc";

export type RosterSortCol =
  | "callsign"
  | "grid"
  | "dist"
  | "snr"
  | "freq"
  | "slot"
  | "age";

export interface QsoIdentity {
  qsoId: string;
  badge: string;
  color: string;
  index: number;
}

export interface HoverState {
  hoveredCallsign: string | null;
  hoveredFreqHz: number | null;
  hoveredColor: string | null;
}
