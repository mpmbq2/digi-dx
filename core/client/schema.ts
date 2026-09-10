// Capability schema defining supported and unsupported core operations.
// Used by the Component Validator Agent to statically verify generated UI/UX code
// and provide alternative suggestions for out-of-scope requests.

export interface MethodCapability {
  name: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  returns: string;
}

export interface EventCapability {
  name: string;
  description: string;
  payloadType: string;
}

export interface UnsupportedCapability {
  feature: string;
  aliases: string[];
  reason: string;
  alternative: string;
}

export interface CoreCapabilitySchema {
  version: string;
  namespace: string;
  methods: MethodCapability[];
  events: EventCapability[];
  unsupported: UnsupportedCapability[];
}

export const CORE_CAPABILITY_SCHEMA: CoreCapabilitySchema = {
  version: "1.0.0",
  namespace: "CoreClient",
  methods: [
    {
      name: "on",
      description: "Subscribe to core events (decode, status, slotClock, txState, tx, log, error)",
      parameters: [
        { name: "event", type: "string", required: true, description: "Event name" },
        { name: "callback", type: "function", required: true, description: "Event listener" }
      ],
      returns: "function"
    },
    {
      name: "off",
      description: "Unsubscribe from core events",
      parameters: [
        { name: "event", type: "string", required: true, description: "Event name" },
        { name: "callback", type: "function", required: true, description: "Event listener" }
      ],
      returns: "void"
    },
    {
      name: "getPolicyState",
      description: "Get active policy state in sandbox",
      parameters: [],
      returns: "object"
    },
    {
      name: "setPolicyState",
      description: "Update active policy state in sandbox",
      parameters: [
        { name: "patch", type: "object", required: true, description: "State patch" }
      ],
      returns: "void"
    },
    {
      name: "transmit",
      description: "Queue or trigger FT8 transmission on a specific audio frequency and slot",
      parameters: [
        { name: "intent", type: "{ af: number; slot: 'even' | 'odd'; message: string }", required: true, description: "Audio frequency (200-3000 Hz), slot parity, and FT8 message text" }
      ],
      returns: "boolean"
    },
    {
      name: "cancelTransmit",
      description: "Cancel active or pending transmission and immediately drop PTT",
      parameters: [],
      returns: "boolean"
    },
    {
      name: "haltTx",
      description: "Emergency halt: drops PTT, cancels transmission, and disables automated transmit",
      parameters: [],
      returns: "boolean"
    },
    {
      name: "setIdentity",
      description: "Configure station callsign and Maidenhead grid locator",
      parameters: [
        { name: "call", type: "string", required: true, description: "Operator callsign" },
        { name: "grid", type: "string", required: true, description: "Maidenhead grid locator (4 or 6 chars)" }
      ],
      returns: "void"
    },
    {
      name: "setDialFreq",
      description: "Set transceiver RF dial frequency in MHz via CAT",
      parameters: [
        { name: "mhz", type: "number | null", required: true, description: "Dial frequency in MHz (e.g. 14.074), or null to clear" }
      ],
      returns: "boolean"
    },
    {
      name: "setAf",
      description: "Set default audio frequency offset in Hertz (200-3000)",
      parameters: [
        { name: "af", type: "number", required: true, description: "Audio offset in Hz" }
      ],
      returns: "void"
    },
    {
      name: "setSlot",
      description: "Set default transmit slot parity",
      parameters: [
        { name: "slot", type: "'even' | 'odd'", required: true, description: "Slot parity" }
      ],
      returns: "void"
    },
    {
      name: "callCq",
      description: "Initiate CQ calling sequence on specified or default slot",
      parameters: [
        { name: "slot", type: "'even' | 'odd'", required: false, description: "Optional slot override" },
        { name: "identity", type: "{ myCall?: string; myGrid?: string }", required: false, description: "Optional identity override" }
      ],
      returns: "void"
    },
    {
      name: "stopCq",
      description: "Halt active CQ sequence",
      parameters: [
        { name: "reason", type: "string", required: false, description: "Optional explanation for stopping CQ" }
      ],
      returns: "void"
    },
    {
      name: "replyToCall",
      description: "Queue reply sequence to a decoded station callsign",
      parameters: [
        { name: "call", type: "string", required: true, description: "Target station callsign" },
        { name: "identity", type: "{ myCall?: string; myGrid?: string }", required: false, description: "Optional identity override" }
      ],
      returns: "void"
    },
    {
      name: "setTxEnabled",
      description: "Enable or disable automated transmission engine",
      parameters: [
        { name: "enabled", type: "boolean", required: true, description: "True to enable, false to disable" }
      ],
      returns: "void"
    },
    {
      name: "claimControl",
      description: "Claim single-operator control of the radio station",
      parameters: [
        { name: "token", type: "string", required: false, description: "Optional authentication token" }
      ],
      returns: "boolean"
    },
    {
      name: "releaseControl",
      description: "Release control claim on the radio station",
      parameters: [],
      returns: "boolean"
    },
    {
      name: "getStatus",
      description: "Request latest daemon status update",
      parameters: [],
      returns: "boolean"
    },
    {
      name: "getConfig",
      description: "Request station setup and hardware configuration",
      parameters: [],
      returns: "boolean"
    }
  ],
  events: [
    {
      name: "decode",
      description: "Emitted when a new FT8 message is demodulated",
      payloadType: "DecodeEvent"
    },
    {
      name: "status",
      description: "Emitted when daemon or station status changes",
      payloadType: "DaemonStatus"
    },
    {
      name: "slotClock",
      description: "Emitted on slot clock synchronization updates",
      payloadType: "SlotClockSpec"
    },
    {
      name: "txState",
      description: "Emitted when transmitter state changes (idle, pending, active)",
      payloadType: "TxStatus"
    },
    {
      name: "tx",
      description: "Emitted when an FT8 transmission commences",
      payloadType: "TxEvent"
    },
    {
      name: "log",
      description: "Emitted for system diagnostic and operational log messages",
      payloadType: "LogEvent"
    },
    {
      name: "error",
      description: "Emitted on protocol or command errors",
      payloadType: "ErrorMessage"
    }
  ],
  unsupported: [
    {
      feature: "antenna_rotator",
      aliases: ["rotator", "beam", "azimuth", "elevation", "rotateAntenna", "setAntennaHeading"],
      reason: "Antenna rotator hardware control is not part of the core radio transceiver interface.",
      alternative: "Display a visual heading alert card in the UI showing the target azimuth so the operator can adjust their rotator manually."
    },
    {
      feature: "power_control",
      aliases: ["power", "watts", "amplifier", "tunePower", "setRfPower"],
      reason: "RF power output levels and amplifier tuning are physical hardware controls not exposed via the digital audio stream.",
      alternative: "Display an audio/RF drive reminder banner or prompt the operator to adjust their rig slider."
    },
    {
      feature: "raw_cat",
      aliases: ["sendCatRaw", "serialWrite", "rawCatCommand"],
      reason: "Raw arbitrary CAT command passthrough is restricted to prevent hardware damage.",
      alternative: "Use standard setDialFreq() or supported transmit APIs."
    },
    {
      feature: "network_fetch",
      aliases: ["fetch", "XMLHttpRequest", "WebSocket", "axios", "httpGet"],
      reason: "Direct network egress from inside periphery sandbox is blocked by security policy.",
      alternative: "Subscribe to CoreClient events and pass state through the provided postMessage RPC bridge."
    },
    {
      feature: "audio_volume",
      aliases: ["setSystemVolume", "masterGain", "soundcardGain"],
      reason: "Host OS master soundcard volume manipulation is not permitted inside web sandbox.",
      alternative: "Provide an in-app software audio indicator or alert threshold slider."
    }
  ]
};

export interface CapabilityCheckResult {
  valid: boolean;
  feature: string;
  method?: MethodCapability;
  event?: EventCapability;
  unsupported?: UnsupportedCapability;
  reason?: string;
  alternative?: string;
}

export function validateCoreCapability(identifier: string): CapabilityCheckResult {
  const normalized = identifier.trim();

  // Check supported methods
  const method = CORE_CAPABILITY_SCHEMA.methods.find(
    (m) => m.name.toLowerCase() === normalized.toLowerCase()
  );
  if (method) {
    return { valid: true, feature: method.name, method };
  }

  // Check supported events
  const event = CORE_CAPABILITY_SCHEMA.events.find(
    (e) => e.name.toLowerCase() === normalized.toLowerCase()
  );
  if (event) {
    return { valid: true, feature: event.name, event };
  }

  // Check unsupported capabilities and aliases
  for (const unsupp of CORE_CAPABILITY_SCHEMA.unsupported) {
    if (
      unsupp.feature.toLowerCase() === normalized.toLowerCase() ||
      unsupp.aliases.some((alias) => alias.toLowerCase() === normalized.toLowerCase())
    ) {
      return {
        valid: false,
        feature: unsupp.feature,
        unsupported: unsupp,
        reason: unsupp.reason,
        alternative: unsupp.alternative
      };
    }
  }

  return {
    valid: false,
    feature: normalized,
    reason: `'${normalized}' is not recognized in the CoreClient capability schema.`,
    alternative: "Consult CORE_CAPABILITY_SCHEMA.methods and events for supported capabilities."
  };
}
