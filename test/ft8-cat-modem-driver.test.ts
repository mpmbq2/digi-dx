import { EventEmitter, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";

const lineHandlers: Array<(line: string) => void> = [];

vi.mock("node:readline", () => ({
  default: {
    createInterface: () => ({
      on: (event: string, handler: (line: string) => void) => {
        if (event === "line") {
          lineHandlers.push(handler);
        }
      },
      close: () => undefined
    })
  },
  createInterface: () => ({
    on: (event: string, handler: (line: string) => void) => {
      if (event === "line") {
        lineHandlers.push(handler);
      }
    },
    close: () => undefined
  })
}));

import { encodeTransmitLine } from "../src/daemon/engine-driver.js";
import { Ft8CatModemDriver, type SpawnFn } from "../src/daemon/ft8-cat-modem-driver.js";
import { parseInternalUdpLineToDriver } from "../src/daemon/ft8-udp-parse.js";

describe("encodeTransmitLine", () => {
  it("encodes even and odd slot intents", () => {
    expect(encodeTransmitLine({ af: 1400, slot: "even", message: "CQ N1MPM FN33" })).toBe("1400E CQ N1MPM FN33");
    expect(encodeTransmitLine({ af: 1600, slot: "odd", message: "K1ABC N1MPM R-15" })).toBe("1600O K1ABC N1MPM R-15");
  });
});

describe("parseInternalUdpLineToDriver", () => {
  it("produces driver decode matching parser fixtures", () => {
    expect(parseInternalUdpLineToDriver("1783048560 144.174 Rx FT8     10 -0.6 2024 WM8Q DL0EO -17")).toEqual({
      ts: 1783048560,
      snr: 10,
      dt: -0.6,
      af: 2024,
      mode: "FT8",
      message: "WM8Q DL0EO -17"
    });
  });
});

describe("Ft8CatModemDriver", () => {
  it("emits ptt true on stdout TX: 1", async () => {
    lineHandlers.length = 0;
    const { driver, emitStdout } = createMockDriver({ verifyAudioDevice: false });
    const ptt = vi.fn();
    driver.on("ptt", ptt);

    await driver.start(dummySession());
    emitStdout("TX: 1");
    expect(ptt).toHaveBeenCalledWith(true);
    await driver.stop();
  });

  it("writes encoded stdin lines for transmit", async () => {
    const { driver, stdinWrites } = createMockDriver({ verifyAudioDevice: false });
    await driver.start(dummySession());
    await driver.transmit({ af: 1400, slot: "even", message: "CQ N1MPM FN33" });
    expect(stdinWrites).toContain("1400E CQ N1MPM FN33");
    await driver.stop();
  });

  it("writes STOP on cancelTransmit", async () => {
    const { driver, stdinWrites } = createMockDriver({ verifyAudioDevice: false });
    await driver.start(dummySession());
    await driver.cancelTransmit();
    expect(stdinWrites).toContain("STOP");
    await driver.stop();
  });

  it("spawns dummy rigctld when cat mode is dummy", async () => {
    const spawns: Array<{ command: string; args: string[] }> = [];
    const { driver } = createMockDriver({
      verifyAudioDevice: false,
      spawnFn: (command, args) => {
        spawns.push({ command, args: [...args] });
        return makeChildProcess([]);
      }
    });

    await driver.start(dummySession());
    expect(spawns.some((entry) => entry.command === "rigctld" && entry.args.includes("-m"))).toBe(true);
    await driver.stop();
  });
});

function dummySession() {
  return {
    mode: "FT8" as const,
    device: { id: 1 },
    callsign: "N1MPM",
    grid: "FN33",
    cat: { mode: "dummy" as const, port: 4532 }
  };
}

function createMockDriver(options: {
  verifyAudioDevice?: boolean;
  spawnFn?: SpawnFn;
}) {
  const stdinWrites: string[] = [];
  const spawnFn: SpawnFn =
    options.spawnFn ??
    ((_command, _args) => makeChildProcess(stdinWrites));

  const driver = new Ft8CatModemDriver({
    verifyAudioDevice: options.verifyAudioDevice ?? false,
    paths: { ft8cat: "ft8cat", ft8modem: "ft8modem", rigctld: "rigctld" },
    spawnFn,
    connectivity: {
      canConnect: async () => false,
      waitForConnect: async () => true
    },
    bindUdpPort: async () => 45123
  });

  return {
    driver,
    stdinWrites,
    emitStdout(line: string) {
      for (const handler of lineHandlers) {
        handler(line);
      }
    }
  };
}

function makeChildProcess(stdinWrites: string[]): ChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const originalWrite = stdin.write.bind(stdin);
  stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stdinWrites.push(String(chunk).trim());
    return originalWrite(chunk, ...(rest as []));
  }) as typeof stdin.write;

  const child = new EventEmitter() as ChildProcess;
  child.stdin = stdin as ChildProcess["stdin"];
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = ((signal?: NodeJS.Signals) => {
    child.exitCode = 0;
    child.signalCode = signal ?? null;
    child.emit("exit", 0, signal ?? null);
    return true;
  }) as ChildProcess["kill"];
  return child;
}
