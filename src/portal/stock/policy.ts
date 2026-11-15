import type { DecodeEvent, TxSlot } from "../../../core/protocol.js";

// StockPolicy — Pre-built FT8 automation and caller prioritization policy (R15, R16, AE4).
// Manages CQ responses, distance ranking, caller queueing, and configurable operational hooks.

export interface QueuedCaller {
  call: string;
  grid?: string;
  snr: number;
  distanceKm?: number;
  isNewGrid?: boolean;
  timestamp: number;
}

export interface StockPolicyConfig {
  autoReply: boolean;
  prioritizeDistance: boolean;
  alertOn73: boolean; // AE4: Audio alert when 73 received
  audioBeepEnabled: boolean;
  minDistanceKm?: number;
}

export interface ActiveQsoState {
  theirCall: string;
  theirGrid?: string;
  step: "call-grid" | "report" | "r-report" | "rr73" | "73" | "complete";
  sentReport?: string;
  receivedReport?: string;
  slot: TxSlot;
  af: number;
}

export class StockPolicy {
  private config: StockPolicyConfig;
  private queue: QueuedCaller[] = [];
  private activeQso: ActiveQsoState | null = null;
  private workedGrids = new Set<string>();
  private alertsEmitted: string[] = [];

  constructor(config: Partial<StockPolicyConfig> = {}) {
    this.config = {
      autoReply: true,
      prioritizeDistance: true,
      alertOn73: false,
      audioBeepEnabled: false,
      ...config
    };
  }

  get currentConfig(): StockPolicyConfig {
    return { ...this.config };
  }

  get callerQueue(): QueuedCaller[] {
    return [...this.queue];
  }

  get currentQso(): ActiveQsoState | null {
    return this.activeQso ? { ...this.activeQso } : null;
  }

  get recentAlerts(): string[] {
    return [...this.alertsEmitted];
  }

  // Dynamically update policy parameters without restarting or losing active QSO (AE4)
  updateConfig(patch: Partial<StockPolicyConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  handleDecode(decode: DecodeEvent, myCall: string, myGrid: string): { queued?: QueuedCaller; alert?: string } {
    const parts = decode.message.trim().split(/\s+/);
    if (parts.length < 2) return {};

    const cleanMyCall = myCall.trim().toUpperCase();

    // Check if decode is addressed to my station
    const isToMe = parts[0]?.toUpperCase() === cleanMyCall;
    const senderCall = isToMe ? (parts[1] ?? "") : (parts[1] === cleanMyCall ? parts[0] ?? "" : "");

    // Check for 73 message addressed to me
    if (isToMe && decode.message.includes("73")) {
      if (this.config.alertOn73) {
        const alertMsg = `BEEP: 73 received from ${senderCall}`;
        this.alertsEmitted.push(alertMsg);
        if (this.activeQso && this.activeQso.theirCall === senderCall) {
          this.activeQso.step = "complete";
        }
        return { alert: alertMsg };
      }
    }

    // Check for CQ caller responding to me
    if (isToMe && !this.activeQso) {
      const grid = parts[2] && /^[A-R]{2}[0-9]{2}$/i.test(parts[2]) ? parts[2].toUpperCase() : undefined;
      const distanceKm = grid && myGrid ? calculateGridDistance(myGrid, grid) : 0;

      const caller: QueuedCaller = {
        call: senderCall,
        grid,
        snr: decode.snr,
        distanceKm,
        isNewGrid: grid ? !this.workedGrids.has(grid) : false,
        timestamp: decode.ts
      };

      this.addCaller(caller);
      return { queued: caller };
    }

    return {};
  }

  private addCaller(caller: QueuedCaller): void {
    // Avoid duplicate in queue
    const idx = this.queue.findIndex((c) => c.call === caller.call);
    if (idx >= 0) {
      this.queue[idx] = caller;
    } else {
      this.queue.push(caller);
    }

    // Sort queue by priority
    this.sortQueue();
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      // 1. New grid has top priority
      if (a.isNewGrid && !b.isNewGrid) return -1;
      if (!a.isNewGrid && b.isNewGrid) return 1;

      // 2. Furthest distance if prioritizeDistance is enabled
      if (this.config.prioritizeDistance && (a.distanceKm || b.distanceKm)) {
        return (b.distanceKm ?? 0) - (a.distanceKm ?? 0);
      }

      // 3. Highest SNR
      return b.snr - a.snr;
    });
  }

  startQso(call: string, af = 1200, slot: TxSlot = "even"): ActiveQsoState | null {
    const caller = this.queue.find((c) => c.call === call);
    this.activeQso = {
      theirCall: call,
      theirGrid: caller?.grid,
      step: "call-grid",
      slot,
      af
    };
    // Remove from queue
    this.queue = this.queue.filter((c) => c.call !== call);
    return this.activeQso;
  }

  advanceQso(nextStep: ActiveQsoState["step"]): void {
    if (this.activeQso) {
      this.activeQso.step = nextStep;
      if (nextStep === "complete" && this.activeQso.theirGrid) {
        this.workedGrids.add(this.activeQso.theirGrid);
      }
    }
  }

  finishQso(): void {
    this.activeQso = null;
  }
}

// Approximate Maidenhead grid distance calculation in kilometers
export function calculateGridDistance(grid1: string, grid2: string): number {
  const g1 = parseGridToLatLon(grid1);
  const g2 = parseGridToLatLon(grid2);
  if (!g1 || !g2) return 0;

  const R = 6371; // Earth radius in km
  const dLat = ((g2.lat - g1.lat) * Math.PI) / 180;
  const dLon = ((g2.lon - g1.lon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((g1.lat * Math.PI) / 180) *
      Math.cos((g2.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function parseGridToLatLon(grid: string): { lat: number; lon: number } | null {
  if (!grid || grid.length < 4) return null;
  const upper = grid.toUpperCase();
  const lonField = upper.charCodeAt(0) - 65;
  const latField = upper.charCodeAt(1) - 65;
  const lonSquare = Number(upper[2]);
  const latSquare = Number(upper[3]);

  if (isNaN(lonSquare) || isNaN(latSquare)) return null;

  const lon = lonField * 20 + lonSquare * 2 - 180 + 1;
  const lat = latField * 10 + latSquare * 1 - 90 + 0.5;
  return { lat, lon };
}
