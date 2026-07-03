import { describe, expect, it } from "vitest";
import { parseFt8modemHelp } from "../src/daemon/audio-devices.js";

describe("parseFt8modemHelp", () => {
  it("parses single-line ft8modem/PortAudio style device entries", () => {
    const output = `
Audio devices:
  0: Built-in Microphone (inputs=1 outputs=0 defaultSampleRate=48000)
  141: USB Audio CODEC (USB Audio) - inputs: 2 outputs: 2 rate: 48000 Hz
`;

    expect(parseFt8modemHelp(output)).toEqual([
      {
        id: 0,
        name: "Built-in Microphone",
        inputs: 1,
        outputs: 0,
        defaultSampleRate: 48000
      },
      {
        id: 141,
        name: "USB Audio CODEC",
        inputs: 2,
        outputs: 2,
        defaultSampleRate: 48000
      }
    ]);
  });

  it("ignores unrelated help text", () => {
    expect(parseFt8modemHelp("usage: ft8modem FT8 <audio-device>\n")).toEqual([]);
  });
});
