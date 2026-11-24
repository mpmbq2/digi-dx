import type { ActiveQso } from "../../types";
import type { QsoIdentity } from "./types";
import { QSO_PALETTE } from "./utils";

interface SessionIdentityRegistry {
  sessionKey: string;
  nextNumber: number;
  byQsoId: Map<string, QsoIdentity>;
}

const registry: SessionIdentityRegistry = {
  sessionKey: "",
  nextNumber: 1,
  byQsoId: new Map(),
};

/**
 * Assign and persist stable Q1/Q2/Q3... numbers and accent colors per QSO ID
 * across re-renders and tab switches within the same session.
 */
export function resolveQsoIdentities(
  sessionKey: string,
  activeQsos: ActiveQso[]
): Map<string, QsoIdentity> {
  if (!sessionKey) {
    registry.sessionKey = "";
    registry.nextNumber = 1;
    registry.byQsoId.clear();
    return new Map();
  }

  if (registry.sessionKey !== sessionKey) {
    registry.sessionKey = sessionKey;
    registry.nextNumber = 1;
    registry.byQsoId.clear();
  }

  const out = new Map<string, QsoIdentity>();
  for (const q of activeQsos) {
    let id = registry.byQsoId.get(q.qso_id);
    if (!id) {
      const idx = registry.nextNumber++;
      id = {
        qsoId: q.qso_id,
        badge: `Q${idx}`,
        color: QSO_PALETTE[(idx - 1) % QSO_PALETTE.length],
        index: idx,
      };
      registry.byQsoId.set(q.qso_id, id);
    }
    out.set(q.qso_id, id);
  }
  return out;
}
