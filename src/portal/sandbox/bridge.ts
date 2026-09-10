import { EventEmitter } from "node:events";
import type { CoreClient } from "../../../core/client/index.js";
import { validateCoreCapability } from "../../../core/client/schema.js";
import type { DaemonCommand, DecodeEvent, ServerMessage } from "../../../core/protocol.js";

// SandboxBridge — postMessage RPC bridge between the cloud portal and isolated iframe sandbox (R8, R9, R10, R11, AE3).

export interface SandboxRpcMessage {
  channel: string;
  type: "rpc_command" | "rpc_event" | "policy_state_sync" | "mount_policy" | "mount_interaction";
  payload?: unknown;
  state?: unknown;
  code?: string;
}

export interface PolicyState {
  callerQueue: Array<{ call: string; grid?: string; distanceKm?: number; snr?: number }>;
  currentQso: { theirCall: string; step: string } | null;
  rules: Record<string, unknown>;
}

export interface PeripheryHostOptions {
  coreClient: CoreClient;
  channelId?: string;
  postMessageToSandbox: (message: SandboxRpcMessage) => void;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

export class PeripheryHostBridge extends EventEmitter {
  private readonly coreClient: CoreClient;
  private readonly channelId: string;
  private readonly postMessage: (message: SandboxRpcMessage) => void;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private activePolicyCode: string | null = null;
  private activeInteractionCode: string | null = null;
  private policyState: PolicyState = {
    callerQueue: [],
    currentQso: null,
    rules: {}
  };
  private unsubs: Array<() => void> = [];

  constructor(options: PeripheryHostOptions) {
    super();
    this.coreClient = options.coreClient;
    this.channelId = options.channelId ?? "digi-dx-periphery";
    this.postMessage = options.postMessageToSandbox;
    this.logger = options.logger ?? console;

    this.subscribeToCore();
  }

  private subscribeToCore(): void {
    const forwardEvent = (eventName: string, payload: unknown) => {
      this.postMessage({
        channel: this.channelId,
        type: "rpc_event",
        payload: { type: eventName, ...(payload as object) }
      });
    };

    this.unsubs.push(this.coreClient.on("decode", (d) => forwardEvent("decode", d)));
    this.unsubs.push(this.coreClient.on("status", (s) => forwardEvent("status", s)));
    this.unsubs.push(this.coreClient.on("slotClock", (c) => forwardEvent("slotClock", c)));
    this.unsubs.push(this.coreClient.on("txState", (tx) => forwardEvent("txState", tx)));
    this.unsubs.push(this.coreClient.on("tx", (tx) => forwardEvent("tx", tx)));
    this.unsubs.push(this.coreClient.on("log", (l) => forwardEvent("log", l)));
  }

  get currentPolicyState(): PolicyState {
    return { ...this.policyState };
  }

  // Handle incoming RPC message from inside the iframe sandbox
  dispatchFromSandbox(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const rpc = message as SandboxRpcMessage;
    if (rpc.channel !== this.channelId) return;

    if (rpc.type === "rpc_command" && rpc.payload) {
      this.handleSandboxCommand(rpc.payload as DaemonCommand);
      return;
    }

    if (rpc.type === "policy_state_sync" && rpc.state) {
      this.policyState = rpc.state as PolicyState;
      this.emit("policyStateUpdated", this.policyState);
      return;
    }
  }

  private handleSandboxCommand(cmd: DaemonCommand): void {
    const validation = validateCoreCapability(cmd.type);
    if (!validation.valid) {
      this.logger.warn(`[sandbox-security] blocked unapproved capability call: ${cmd.type}`);
      this.postMessage({
        channel: this.channelId,
        type: "rpc_event",
        payload: {
          type: "error",
          code: "CAPABILITY_REJECTED",
          message: validation.reason,
          alternative: validation.alternative
        }
      });
      return;
    }

    switch (cmd.type) {
      case "transmit":
        this.coreClient.transmit({
          af: (cmd as { af: number }).af,
          slot: (cmd as { slot: "even" | "odd" }).slot,
          message: (cmd as { message: string }).message
        });
        break;
      case "cancel_transmit":
        this.coreClient.cancelTransmit();
        break;
      case "claim_control":
        this.coreClient.claimControl((cmd as { token?: string }).token);
        break;
      case "release_control":
        this.coreClient.releaseControl();
        break;
      case "get_status":
        this.coreClient.getStatus();
        break;
      case "get_config":
        this.coreClient.getConfig();
        break;
    }
  }

  // Mount or update Policy layer (automation/sequencing logic)
  mountPolicy(code: string): void {
    this.activePolicyCode = code;
    this.postMessage({
      channel: this.channelId,
      type: "mount_policy",
      code,
      state: this.policyState
    });
  }

  // Mount or switch Interaction layer (UI layout) while preserving Policy state (AE3, R9)
  mountInteraction(code: string): void {
    this.activeInteractionCode = code;
    this.postMessage({
      channel: this.channelId,
      type: "mount_interaction",
      code,
      state: this.policyState
    });
  }

  // Update policy state externally (e.g. caller queue adjustments)
  syncPolicyState(state: Partial<PolicyState>): void {
    this.policyState = { ...this.policyState, ...state };
    this.postMessage({
      channel: this.channelId,
      type: "policy_state_sync",
      state: this.policyState
    });
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.removeAllListeners();
  }
}
