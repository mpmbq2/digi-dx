import type { QsoLogEntry } from "./qso.js";

// Amateur band edges (MHz) used to derive the ADIF BAND tag from a dial
// frequency. Ranges are inclusive of the lower edge and exclusive of the upper.
const BANDS: Array<{ lo: number; hi: number; name: string }> = [
  { lo: 1.8, hi: 2.0, name: "160m" },
  { lo: 3.5, hi: 4.0, name: "80m" },
  { lo: 5.06, hi: 5.45, name: "60m" },
  { lo: 7.0, hi: 7.3, name: "40m" },
  { lo: 10.1, hi: 10.15, name: "30m" },
  { lo: 14.0, hi: 14.35, name: "20m" },
  { lo: 18.068, hi: 18.168, name: "17m" },
  { lo: 21.0, hi: 21.45, name: "15m" },
  { lo: 24.89, hi: 24.99, name: "12m" },
  { lo: 28.0, hi: 29.7, name: "10m" },
  { lo: 50, hi: 54, name: "6m" },
  { lo: 144, hi: 148, name: "2m" },
  { lo: 222, hi: 225, name: "1.25m" },
  { lo: 420, hi: 450, name: "70cm" }
];

export function bandForMHz(mhz: number): string | null {
  const band = BANDS.find((entry) => mhz >= entry.lo && mhz < entry.hi);
  return band ? band.name : null;
}

// Encode one ADIF field as <NAME:LEN>VALUE. Byte length (not code-point count)
// is what ADIF specifies; ASCII call/grid/report data makes them equal here.
function field(name: string, value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  return `<${name}:${bytes}>${value} `;
}

function optionalField(name: string, value: string | null | undefined): string {
  return value ? field(name, value) : "";
}

function adifDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}

function adifTime(iso: string): string {
  return iso.slice(11, 19).replace(/:/g, "");
}

export function entryToAdif(entry: QsoLogEntry): string {
  const mhz = entry.dialFreqHz != null ? entry.dialFreqHz / 1e6 : null;
  const parts = [
    field("CALL", entry.theirCall),
    optionalField("GRIDSQUARE", entry.theirGrid),
    field("MODE", "FT8"),
    field("QSO_DATE", adifDate(entry.startedAt)),
    field("TIME_ON", adifTime(entry.startedAt)),
    field("QSO_DATE_OFF", adifDate(entry.completedAt)),
    field("TIME_OFF", adifTime(entry.completedAt)),
    optionalField("RST_SENT", entry.sentReport),
    optionalField("RST_RCVD", entry.receivedReport),
    mhz != null ? field("FREQ", mhz.toFixed(6)) : "",
    mhz != null ? optionalField("BAND", bandForMHz(mhz)) : "",
    field("STATION_CALLSIGN", entry.myCall),
    field("OPERATOR", entry.myCall),
    optionalField("MY_GRIDSQUARE", entry.myGrid)
  ];
  return `${parts.join("")}<EOR>`;
}

export function buildAdif(entries: QsoLogEntry[], generatedAt = new Date()): string {
  const header = [
    "digi-dx ADIF export",
    field("ADIF_VER", "3.1.4"),
    field("PROGRAMID", "digi-dx"),
    field("CREATED_TIMESTAMP", `${adifDate(generatedAt.toISOString())} ${adifTime(generatedAt.toISOString())}`),
    "<EOH>"
  ].join("\n");
  const records = entries.map(entryToAdif).join("\n");
  return `${header}\n${records}${records ? "\n" : ""}`;
}
