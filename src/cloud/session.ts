import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// SessionManager — Enforces single-operator control exclusivity per station (R7).
// Only one active controlling operator connection is permitted per radio station at a time.
// Additional connected clients are restricted to read-only telemetry viewers.

export interface SessionClaim {
  sessionId: string;
  stationId: string;
  clientId: string;
  operatorCall?: string;
  claimedAt: number;
}

export interface SessionEvents {
  controlClaimed: [SessionClaim];
  controlReleased: [{ stationId: string; sessionId: string }];
}

export class StationSessionManager extends EventEmitter<SessionEvents> {
  // stationId -> active SessionClaim
  private activeControllers = new Map<string, SessionClaim>();
  // stationId -> station pairing session token
  private stationTokens = new Map<string, string>();

  registerStation(stationId: string, token?: string): string {
    const sessionToken = token ?? randomUUID();
    this.stationTokens.set(stationId, sessionToken);
    return sessionToken;
  }

  isStationTokenValid(stationId: string, token: string): boolean {
    const expected = this.stationTokens.get(stationId);
    return expected !== undefined && expected === token;
  }

  hasController(stationId: string): boolean {
    return this.activeControllers.has(stationId);
  }

  getController(stationId: string): SessionClaim | null {
    return this.activeControllers.get(stationId) ?? null;
  }

  isController(stationId: string, clientId: string): boolean {
    const claim = this.activeControllers.get(stationId);
    return claim !== undefined && claim.clientId === clientId;
  }

  claimControl(stationId: string, clientId: string, operatorCall?: string): { success: boolean; claim?: SessionClaim; error?: string } {
    const existing = this.activeControllers.get(stationId);
    if (existing) {
      if (existing.clientId === clientId) {
        return { success: true, claim: existing };
      }
      return {
        success: false,
        error: "CONTROL_UNAVAILABLE: another operator currently holds exclusive control of this station"
      };
    }

    const claim: SessionClaim = {
      sessionId: randomUUID(),
      stationId,
      clientId,
      operatorCall,
      claimedAt: Date.now()
    };
    this.activeControllers.set(stationId, claim);
    this.emit("controlClaimed", claim);
    return { success: true, claim };
  }

  releaseControl(stationId: string, clientId: string): boolean {
    const existing = this.activeControllers.get(stationId);
    if (!existing || existing.clientId !== clientId) {
      return false;
    }
    this.activeControllers.delete(stationId);
    this.emit("controlReleased", { stationId, sessionId: existing.sessionId });
    return true;
  }

  releaseAllForClient(clientId: string): void {
    for (const [stationId, claim] of this.activeControllers.entries()) {
      if (claim.clientId === clientId) {
        this.activeControllers.delete(stationId);
        this.emit("controlReleased", { stationId, sessionId: claim.sessionId });
      }
    }
  }

  clear(): void {
    this.activeControllers.clear();
    this.stationTokens.clear();
  }
}
