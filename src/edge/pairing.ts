import { randomInt, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// EdgePairingService — Manages ephemeral 6-digit pairing code generation and
// claim verification for connecting the unitary edge client to the remote cloud (KTD3, R2, R3, F1).

export interface PairingState {
  status: "unpaired" | "pairing" | "paired";
  stationId: string;
  activeCode: string | null;
  expiresAt: number | null;
  pairedAt: number | null;
  sessionToken: string | null;
}

export interface PairingEvents {
  codeGenerated: [{ code: string; expiresAt: number }];
  paired: [{ sessionToken: string; stationId: string }];
  unpaired: [];
  expired: [];
}

export interface EdgePairingOptions {
  stationId?: string;
  codeLifetimeMs?: number; // default 5 minutes (300_000 ms)
}

export class EdgePairingService extends EventEmitter<PairingEvents> {
  private readonly stationId: string;
  private readonly lifetimeMs: number;
  private status: "unpaired" | "pairing" | "paired" = "unpaired";
  private activeCode: string | null = null;
  private expiresAt: number | null = null;
  private pairedAt: number | null = null;
  private sessionToken: string | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;

  constructor(options: EdgePairingOptions = {}) {
    super();
    this.stationId = options.stationId ?? randomUUID();
    this.lifetimeMs = options.codeLifetimeMs ?? 300_000;
  }

  get state(): PairingState {
    return {
      status: this.status,
      stationId: this.stationId,
      activeCode: this.activeCode,
      expiresAt: this.expiresAt,
      pairedAt: this.pairedAt,
      sessionToken: this.sessionToken
    };
  }

  get isPaired(): boolean {
    return this.status === "paired";
  }

  generatePairingCode(): { code: string; expiresAt: number } {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }

    // Cryptographic 6-digit numeric PIN (100000 - 999999)
    const code = String(randomInt(100000, 1000000));
    const expiresAt = Date.now() + this.lifetimeMs;

    this.activeCode = code;
    this.expiresAt = expiresAt;
    this.status = "pairing";

    this.expiryTimer = setTimeout(() => {
      this.handleExpiration();
    }, this.lifetimeMs);

    this.emit("codeGenerated", { code, expiresAt });
    return { code, expiresAt };
  }

  verifyAndClaim(code: string, sessionToken: string): boolean {
    if (this.status === "paired") {
      return false;
    }
    if (!this.activeCode || !this.expiresAt) {
      return false;
    }
    if (Date.now() > this.expiresAt) {
      this.handleExpiration();
      return false;
    }
    if (this.activeCode !== code.trim()) {
      return false;
    }

    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }

    this.status = "paired";
    this.activeCode = null;
    this.expiresAt = null;
    this.pairedAt = Date.now();
    this.sessionToken = sessionToken;

    this.emit("paired", { sessionToken, stationId: this.stationId });
    return true;
  }

  unpair(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.status = "unpaired";
    this.activeCode = null;
    this.expiresAt = null;
    this.pairedAt = null;
    this.sessionToken = null;
    this.emit("unpaired");
  }

  private handleExpiration(): void {
    if (this.status === "pairing") {
      this.status = "unpaired";
      this.activeCode = null;
      this.expiresAt = null;
      this.expiryTimer = null;
      this.emit("expired");
    }
  }

  dispose(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.removeAllListeners();
  }
}
