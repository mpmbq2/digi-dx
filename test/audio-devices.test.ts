import { describe, expect, it } from "vitest";
import { parseFt8modemHelp } from "../src/daemon/audio-devices.js";

// Captured verbatim from `ft8modem -h` on real hardware (ft8modem exits with
// status 1 for -h, and reports no channel counts, unlike a PortAudio device
// dump).
const REAL_FT8MODEM_HELP = `
Usage: ft8modem [options] <mode> [<device>]

    Starts a software modem for FT8, FT4, and similar HF digital modes.

       <mode> is one of { FT4, FT8, JT9, JT65, WSPR }
       <device> is the sound card ID, and may be one of these devices:

          + ID = 129: "Default ALSA Device", best rate = 48000
          + ID = 130: "PulseAudio Sound Server", best rate = 48000
          + ID = 131: "HDA Intel PCH (ALC892 Analog)", best rate = 48000
          + ID = 133: "HDA Intel PCH (ALC892 Alt Analog)", best rate = 48000
          + ID = 141: "USB Audio CODEC (USB Audio)", best rate = 48000

    If your sound device is not shown above, it is likely because it
    reports no inputs to the operating system, or it is already in
    use by another program.
`;

describe("parseFt8modemHelp", () => {
  it("parses real ft8modem -h device entries", () => {
    expect(parseFt8modemHelp(REAL_FT8MODEM_HELP)).toEqual([
      { id: 129, name: "Default ALSA Device", inputs: 0, outputs: 0, defaultSampleRate: 48000 },
      { id: 130, name: "PulseAudio Sound Server", inputs: 0, outputs: 0, defaultSampleRate: 48000 },
      { id: 131, name: "HDA Intel PCH (ALC892 Analog)", inputs: 0, outputs: 0, defaultSampleRate: 48000 },
      { id: 133, name: "HDA Intel PCH (ALC892 Alt Analog)", inputs: 0, outputs: 0, defaultSampleRate: 48000 },
      { id: 141, name: "USB Audio CODEC (USB Audio)", inputs: 0, outputs: 0, defaultSampleRate: 48000 }
    ]);
  });

  it("parses single-line PortAudio style device entries", () => {
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
