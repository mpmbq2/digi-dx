const GRID_RE = /^[A-R]{2}\d{2}([A-X]{2})?$/i;
const TERMINAL_TOKENS = new Set(["RRR", "RR73", "73"]);

export function isTerminalPayload(token: string): boolean {
  return TERMINAL_TOKENS.has(token.trim().toUpperCase());
}

export function isMaidenheadGrid(token: string): boolean {
  const clean = token.trim().toUpperCase();
  if (isTerminalPayload(clean)) return false;
  return GRID_RE.test(clean);
}

export function gridToLatLon(
  gridRaw: string | null | undefined
): { lat: number; lon: number } | null {
  if (!gridRaw) return null;
  const g = gridRaw.trim().toUpperCase();
  if (!isMaidenheadGrid(g)) return null;

  const lonField = g.charCodeAt(0) - 65;
  const latField = g.charCodeAt(1) - 65;
  const lonSquare = Number(g[2]);
  const latSquare = Number(g[3]);

  let lon = lonField * 20 - 180 + lonSquare * 2;
  let lat = latField * 10 - 90 + latSquare * 1;

  if (g.length === 6) {
    const lonSub = g.charCodeAt(4) - 65;
    const latSub = g.charCodeAt(5) - 65;
    lon += (lonSub + 0.5) * (2 / 24);
    lat += (latSub + 0.5) * (1 / 24);
  } else {
    lon += 1.0;
    lat += 0.5;
  }
  return { lat, lon };
}

export function gridDistance(
  fromGrid: string | null | undefined,
  toGrid: string | null | undefined
): { km: number; miles: number; bearingDeg: number } | null {
  const a = gridToLatLon(fromGrid);
  const b = gridToLatLon(toGrid);
  if (!a || !b) return null;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  const km = Math.round(6371.0 * c);
  const miles = Math.round(km * 0.621371);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearingDeg = Math.round((toDeg(Math.atan2(y, x)) + 360) % 360);

  return { km, miles, bearingDeg };
}

export function formatChannelKey(
  mode: string,
  freqHz: number | null | undefined
): string {
  const m = (mode || "FT8").trim().toUpperCase() || "FT8";
  if (typeof freqHz === "number" && freqHz > 0) {
    const rounded = Math.round(freqHz / 1000) * 1000;
    return `${m}:${rounded}`;
  }
  return `${m}:unknown`;
}

export interface ParsedFt8Decode {
  type: "cq" | "directed" | "raw";
  to?: string;
  from: string;
  grid: string | null;
  directedCq: string | null;
}

export function parseFt8Decode(rawMessage: string): ParsedFt8Decode {
  const qIdx = rawMessage.indexOf("?");
  const clean = (qIdx >= 0 ? rawMessage.slice(0, qIdx) : rawMessage).trim();
  const tokens = clean.split(/\s+/).map((t) => t.toUpperCase());

  if (tokens[0] === "CQ") {
    if (tokens.length === 2) {
      return { type: "cq", from: tokens[1], grid: null, directedCq: null };
    }
    if (tokens.length === 3) {
      if (isMaidenheadGrid(tokens[2])) {
        return {
          type: "cq",
          from: tokens[1],
          grid: tokens[2],
          directedCq: null,
        };
      }
      return {
        type: "cq",
        from: tokens[2],
        grid: null,
        directedCq: tokens[1],
      };
    }
    if (tokens.length >= 4) {
      return {
        type: "cq",
        from: tokens[2],
        grid: isMaidenheadGrid(tokens[3]) ? tokens[3] : null,
        directedCq: tokens[1],
      };
    }
  }

  if (tokens.length >= 2) {
    const grid =
      tokens.length >= 3 && isMaidenheadGrid(tokens[2]) ? tokens[2] : null;
    return {
      type: "directed",
      to: tokens[0],
      from: tokens[1],
      grid,
      directedCq: null,
    };
  }

  return { type: "raw", from: tokens[0] ?? "", grid: null, directedCq: null };
}
