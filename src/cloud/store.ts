import type { DecodeEvent } from "../../core/protocol.js";
import type { QsoLogEntry } from "../../core/qso.js";

// StationStore — Cloud persistence for station telemetry, decodes, and QSO logs (R5).

export interface StationData {
  stationId: string;
  callsign?: string;
  grid?: string;
  decodes: DecodeEvent[];
  qsos: QsoLogEntry[];
  lastSeen: number;
}

export class StationStore {
  private stations = new Map<string, StationData>();
  private readonly maxDecodesPerStation: number;

  constructor(options: { maxDecodesPerStation?: number } = {}) {
    this.maxDecodesPerStation = options.maxDecodesPerStation ?? 2000;
  }

  private getOrCreate(stationId: string): StationData {
    let station = this.stations.get(stationId);
    if (!station) {
      station = {
        stationId,
        decodes: [],
        qsos: [],
        lastSeen: Date.now()
      };
      this.stations.set(stationId, station);
    }
    return station;
  }

  saveDecode(stationId: string, decode: DecodeEvent): void {
    const station = this.getOrCreate(stationId);
    station.decodes.push(decode);
    station.lastSeen = Date.now();
    if (station.decodes.length > this.maxDecodesPerStation) {
      station.decodes.splice(0, station.decodes.length - this.maxDecodesPerStation);
    }
  }

  getDecodes(stationId: string, limit = 500): DecodeEvent[] {
    const station = this.stations.get(stationId);
    if (!station) return [];
    return station.decodes.slice(-limit);
  }

  saveQso(stationId: string, qso: QsoLogEntry): void {
    const station = this.getOrCreate(stationId);
    // Prevent duplicate entries by callsign + timestamp
    const exists = station.qsos.some(
      (q) => q.theirCall === qso.theirCall && q.completedAt === qso.completedAt
    );
    if (!exists) {
      station.qsos.push(qso);
    }
    station.lastSeen = Date.now();
  }

  getQsos(stationId: string): QsoLogEntry[] {
    const station = this.stations.get(stationId);
    return station ? [...station.qsos] : [];
  }

  updateStationMetadata(stationId: string, meta: { callsign?: string; grid?: string }): void {
    const station = this.getOrCreate(stationId);
    if (meta.callsign) station.callsign = meta.callsign;
    if (meta.grid) station.grid = meta.grid;
    station.lastSeen = Date.now();
  }

  getStationMetadata(stationId: string): { stationId: string; callsign?: string; grid?: string; lastSeen: number } | null {
    const station = this.stations.get(stationId);
    if (!station) return null;
    return {
      stationId: station.stationId,
      callsign: station.callsign,
      grid: station.grid,
      lastSeen: station.lastSeen
    };
  }

  clear(): void {
    this.stations.clear();
  }
}
