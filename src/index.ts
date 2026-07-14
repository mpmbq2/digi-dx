import { Engine } from "./daemon/engine.js";
import { resolveEngineBinaryPaths } from "./daemon/engine-binary-paths.js";
import { Ft8CatModemDriver } from "./daemon/ft8-cat-modem-driver.js";
import { SimulatedDriver, resolveSimOptions } from "./daemon/simulated-driver.js";
import { createDaemonWebSocketServer } from "./daemon/websocket.js";
import { resolveConfigPath } from "./daemon/config.js";

const port = Number(process.env.DIGI_DX_PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("DIGI_DX_PORT must be an integer from 1 to 65535");
}

const paths = await resolveEngineBinaryPaths();

// Both engines are constructed; the session picks between them. Selection cannot
// be a boot-time environment variable: the daemon holds one driver for its
// lifetime, so a user who launched digi-dx normally would be stuck on the real
// engine forever, and the "try it without a radio" entry point would be dead on
// arrival for exactly the user it exists for.
const driver = new Ft8CatModemDriver({ paths });
const simulatedDriver = new SimulatedDriver(resolveSimOptions());
const engine = new Engine({ driver, simulatedDriver });

// The environment variable survives as the headless path: it forces every
// session onto the simulated engine, which is how the verification commands run
// in a container with no radio.
const forceSimulated = process.env.DIGI_DX_ENGINE === "sim";
if (process.env.DIGI_DX_ENGINE !== undefined && !forceSimulated) {
  throw new Error(`DIGI_DX_ENGINE must be 'sim' if set, got '${process.env.DIGI_DX_ENGINE}'`);
}

const ws = createDaemonWebSocketServer({
  engine,
  port,
  authToken: process.env.DIGI_DX_AUTH_TOKEN,
  configPath: resolveConfigPath(),
  forceSimulated,
  // First-run setup needs a device to show a radio-less user, and the real
  // driver has none to offer without hardware.
  listAudioDevices: () => engine.listAudioDevices(forceSimulated ? "simulated" : undefined)
});

console.info(`digi-dx daemon listening on ws://0.0.0.0:${port}`);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.info(`received ${signal}, shutting down`);
  try {
    if (engine.snapshot().state !== "inactive") {
      await engine.stop();
    }
    await ws.close();
  } finally {
    process.exit(0);
  }
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
