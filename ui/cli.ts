import readline from "node:readline";
import { WebSocket } from "ws";

const url = process.env.DIGI_DX_URL ?? "ws://127.0.0.1:8788";
const token = process.env.DIGI_DX_AUTH_TOKEN;

const ws = new WebSocket(url);
let idCounter = 1;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "digi-dx> " });
rl.pause();

function send(command: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) {
    log("not connected yet");
    return;
  }
  const id = String(idCounter++);
  ws.send(JSON.stringify({ id, ...command }));
}

function log(line: string): void {
  console.log(line);
}

ws.on("open", () => {
  log(`connected to ${url}`);
  printHelp();
  rl.resume();
  rl.prompt();
});

ws.on("error", (error) => {
  log(`[connection error] ${error.message}`);
});

ws.on("close", () => {
  log("connection closed");
  process.exit(0);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  renderEvent(msg);
  rl.prompt();
});

function renderEvent(msg: Record<string, unknown>): void {
  switch (msg.type) {
    case "status": {
      const session = msg.session as Record<string, unknown>;
      const tx = msg.tx as Record<string, unknown>;
      const control = msg.control as Record<string, unknown>;
      log(
        `[status] active=${session.active} device=${(session.device as { id?: number } | null)?.id ?? "-"} ` +
          `cat=${session.catConnected} freq=${session.freq ?? "-"} ptt=${session.ptt} ` +
          `call=${session.callsign ?? "-"} grid=${session.grid ?? "-"} | ` +
          `tx=${tx.state} af=${tx.af ?? "-"} slot=${tx.slot ?? "-"} msg=${tx.message ?? "-"} | ` +
          `control held=${control.held} mine=${control.byThisClient}`
      );
      break;
    }
    case "decode": {
      log(`[decode] snr=${msg.snr} dt=${msg.dt} af=${msg.af} ${msg.message}`);
      break;
    }
    case "tx": {
      log(`[tx] af=${msg.af} ${msg.message}`);
      break;
    }
    case "tx_update": {
      log(`[tx_update] state=${msg.state} af=${msg.af ?? "-"} slot=${msg.slot ?? "-"} msg=${msg.message ?? "-"}`);
      break;
    }
    case "log": {
      log(`[${msg.level}] ${msg.message}`);
      break;
    }
    case "error": {
      log(`[error] ${msg.code}: ${msg.message}${msg.details ? ` ${JSON.stringify(msg.details)}` : ""}`);
      break;
    }
    case "config": {
      log(`[config] complete=${msg.complete} ${JSON.stringify(msg.session ?? msg.missing ?? "")}`);
      break;
    }
    case "audio_devices": {
      log("[audio_devices]");
      for (const device of msg.devices as Array<Record<string, unknown>>) {
        log(`  ${device.id}: ${device.name} (rate=${device.defaultSampleRate})`);
      }
      break;
    }
    default:
      log(`[${String(msg.type)}] ${JSON.stringify(msg)}`);
  }
}

function printHelp(): void {
  log(`
commands:
  devices                                       list audio devices
  claim                                         claim control
  release                                       release control
  config                                        show saved config
  save <deviceId> <call> <grid> <catMode> [port]  save config (catMode: rigctld|dummy)
  start [deviceId] [call] [grid] [catMode] [port] start session (no args = use saved config)
  stop                                           stop session
  status                                         request status
  tx <af> <e|o> <message...>                    transmit
  cancel                                         cancel transmit
  help                                           show this help
  quit                                           disconnect and exit
`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    rl.prompt();
    return;
  }

  const [cmd, ...rest] = trimmed.split(/\s+/);

  switch (cmd) {
    case "help":
      printHelp();
      break;
    case "devices":
      send({ type: "list_audio_devices" });
      break;
    case "claim":
      send({ type: "claim_control", ...(token ? { token } : {}) });
      break;
    case "release":
      send({ type: "release_control" });
      break;
    case "config":
      send({ type: "get_config" });
      break;
    case "status":
      send({ type: "get_status" });
      break;
    case "stop":
      send({ type: "stop_session" });
      break;
    case "cancel":
      send({ type: "cancel_transmit" });
      break;
    case "save": {
      const [deviceId, callsign, grid, catMode, catPort] = rest;
      if (!deviceId || !callsign || !grid || !catMode) {
        log("usage: save <deviceId> <call> <grid> <catMode:rigctld|dummy> [port=4532]");
        break;
      }
      send({
        type: "save_config",
        session: {
          mode: "FT8",
          device: { id: Number(deviceId) },
          callsign,
          grid,
          cat: { mode: catMode, port: catPort ? Number(catPort) : 4532 }
        }
      });
      break;
    }
    case "start": {
      if (rest.length === 0) {
        send({ type: "start_session" });
        break;
      }
      const [deviceId, callsign, grid, catMode, catPort] = rest;
      if (!deviceId || !callsign || !grid || !catMode) {
        log("usage: start [deviceId] [call] [grid] [catMode:rigctld|dummy] [port=4532]  (no args = use saved config)");
        break;
      }
      send({
        type: "start_session",
        session: {
          mode: "FT8",
          device: { id: Number(deviceId) },
          callsign,
          grid,
          cat: { mode: catMode, port: catPort ? Number(catPort) : 4532 }
        }
      });
      break;
    }
    case "tx": {
      const [af, slotShort, ...messageParts] = rest;
      const slot = slotShort === "e" ? "even" : slotShort === "o" ? "odd" : slotShort;
      if (!af || (slot !== "even" && slot !== "odd") || messageParts.length === 0) {
        log("usage: tx <af> <e|o> <message...>");
        break;
      }
      send({ type: "transmit", af: Number(af), slot, message: messageParts.join(" ") });
      break;
    }
    case "quit":
    case "exit":
      ws.close();
      return;
    default:
      log(`unknown command '${cmd}', type 'help' for a list`);
  }

  rl.prompt();
});

rl.on("close", () => {
  ws.close();
});
