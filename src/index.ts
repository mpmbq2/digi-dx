import { Engine } from "./daemon/engine.js";
import { resolveEngineBinaryPaths } from "./daemon/engine-binary-paths.js";
import { Ft8CatModemDriver } from "./daemon/ft8-cat-modem-driver.js";
import { createDaemonWebSocketServer } from "./daemon/websocket.js";
import { resolveConfigPath } from "./daemon/config.js";

const port = Number(process.env.DIGI_DX_PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("DIGI_DX_PORT must be an integer from 1 to 65535");
}

const paths = await resolveEngineBinaryPaths();
const driver = new Ft8CatModemDriver({ paths });
const engine = new Engine({ driver });
const ws = createDaemonWebSocketServer({
  engine,
  port,
  authToken: process.env.DIGI_DX_AUTH_TOKEN,
  configPath: resolveConfigPath(),
  listAudioDevices: () => engine.listAudioDevices()
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
