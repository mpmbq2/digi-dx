import type { DecodeItem } from "../types";

const RECONCILE_AF_TOLERANCE_HZ = 15;

/**
 * Merge an incoming FT8 decode into the live decode list without duplicates:
 * - If a decode for the same slot, message, and AF (±15 Hz) already exists, update
 *   it in place (preserving row order) when SNR, AF, DT, backend, or metadata changes.
 * - Otherwise insert at the top of its `ts_sec` slot group so cycle dividers stay intact.
 */
export function reconcileDecode(
  prev: DecodeItem[],
  incoming: DecodeItem,
  maxItems = 300
): DecodeItem[] {
  const incomingMeta = incoming.decoder_metadata ?? null;
  const existingIdx = prev.findIndex(
    (d) =>
      d.ts_sec === incoming.ts_sec &&
      d.message === incoming.message &&
      Math.abs(d.af_hz - incoming.af_hz) <= RECONCILE_AF_TOLERANCE_HZ
  );

  if (existingIdx >= 0) {
    const cur = prev[existingIdx];
    const curMeta = cur.decoder_metadata ?? null;
    if (
      cur.snr_db === incoming.snr_db &&
      cur.af_hz === incoming.af_hz &&
      Math.abs(cur.dt_sec - incoming.dt_sec) < 0.05 &&
      cur.decoder_backend === incoming.decoder_backend &&
      curMeta === incomingMeta
    ) {
      return prev;
    }
    const next = prev.slice();
    next[existingIdx] = { ...incoming, decoder_metadata: incomingMeta };
    return next;
  }

  const normalizedIncoming: DecodeItem = {
    ...incoming,
    decoder_metadata: incomingMeta,
  };
  const insertIdx = prev.findIndex((d) => d.ts_sec <= incoming.ts_sec);
  const next =
    insertIdx < 0
      ? [...prev, normalizedIncoming]
      : [
          ...prev.slice(0, insertIdx),
          normalizedIncoming,
          ...prev.slice(insertIdx),
        ];
  return next.slice(0, maxItems);
}
