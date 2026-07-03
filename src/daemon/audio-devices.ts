import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DaemonError } from "./protocol.js";

const execFileAsync = promisify(execFile);

export interface AudioDevice {
  id: number;
  name: string;
  inputs: number;
  outputs: number;
  defaultSampleRate: number | null;
}

export function resolveFt8modemPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DIGI_DX_FT8MODEM_PATH || "ft8modem";
}

export async function listAudioDevices(ft8modemPath = resolveFt8modemPath()): Promise<AudioDevice[]> {
  try {
    const result = await execFileAsync(ft8modemPath, ["-h"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    const devices = parseFt8modemHelp(`${result.stdout}\n${result.stderr}`);
    if (devices.length === 0) {
      throw new Error("no audio devices found in ft8modem help output");
    }
    return devices;
  } catch (error) {
    if (error instanceof DaemonError) {
      throw error;
    }
    throw new DaemonError("AUDIO_DISCOVERY_FAILED", "failed to discover audio devices", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export function parseFt8modemHelp(output: string): AudioDevice[] {
  const devices = new Map<number, AudioDevice>();

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = parseSingleLineDevice(trimmed) ?? parsePortAudioBlockLine(trimmed);
    if (!parsed) {
      continue;
    }

    devices.set(parsed.id, parsed);
  }

  return [...devices.values()].sort((a, b) => a.id - b.id);
}

function parseSingleLineDevice(line: string): AudioDevice | null {
  const match =
    /^(?:device\s*)?(\d+)\s*[:.)-]\s*(.+?)(?:\s+\(|\s{2,}|\s+-\s+|\s*$)(.*)$/i.exec(line) ??
    /^\[(\d+)]\s*(.+?)(?:\s+\(|\s{2,}|\s+-\s+|\s*$)(.*)$/i.exec(line);
  if (!match) {
    return null;
  }

  const id = Number(match[1]);
  const rest = `${match[2]} ${match[3] ?? ""}`.trim();
  const name = cleanDeviceName(match[2]);
  const inputs = pickNumber(rest, [/\b(?:in|inputs?|maxInputChannels)\s*[=:]?\s*(\d+)/i, /(\d+)\s*(?:in|inputs?)\b/i]);
  const outputs = pickNumber(rest, [
    /\b(?:out|outputs?|maxOutputChannels)\s*[=:]?\s*(\d+)/i,
    /(\d+)\s*(?:out|outputs?)\b/i
  ]);
  const defaultSampleRate = pickNumber(rest, [
    /\b(?:rate|defaultSampleRate)\s*[=:]?\s*(\d{4,6})/i,
    /(\d{4,6})\s*(?:hz|Hz)\b/
  ]);

  return {
    id,
    name,
    inputs: inputs ?? 0,
    outputs: outputs ?? 0,
    defaultSampleRate
  };
}

function parsePortAudioBlockLine(line: string): AudioDevice | null {
  const match = /^(\d+)\s+(.+?)\s+maxInputChannels:\s*(\d+)\s+maxOutputChannels:\s*(\d+).*?defaultSampleRate:\s*(\d+)/i.exec(
    line
  );
  if (!match) {
    return null;
  }

  return {
    id: Number(match[1]),
    name: cleanDeviceName(match[2]),
    inputs: Number(match[3]),
    outputs: Number(match[4]),
    defaultSampleRate: Number(match[5])
  };
}

function pickNumber(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

function cleanDeviceName(name: string): string {
  return name.replace(/\s+\($/, "").replace(/\s+-$/, "").trim();
}
