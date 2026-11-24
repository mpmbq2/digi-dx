import { useEffect, useRef, useState } from "preact/hooks";
import type { ActiveQso, WaterfallEvent } from "../../types";
import { useCrossHighlight } from "./CrossHighlightContext";
import type { QsoIdentity } from "./types";
import { WF_MAX_HZ, WF_MIN_HZ, clamp, hexToRgba, normalizeCall } from "./utils";

interface Props {
  frames: WaterfallEvent[];
  rxHz: number;
  txHz: number;
  txEnabled: boolean;
  evenOccupiedHz: number[];
  oddOccupiedHz: number[];
  activeQsos: ActiveQso[];
  identities: Map<string, QsoIdentity>;
  rosterFreqMap: Map<string, number>;
  onChangeRxHz: (hz: number) => void;
  onCommitTxHz: (hz: number) => void;
}

const COLOR_LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r = 0;
    let g = 0;
    let b = 0;
    if (t < 0.25) {
      const k = t / 0.25;
      r = 4 + k * 8;
      g = 10 + k * 24;
      b = 24 + k * 56;
    } else if (t < 0.52) {
      const k = (t - 0.25) / 0.27;
      r = 12 + k * 14;
      g = 34 + k * 136;
      b = 80 + k * 125;
    } else if (t < 0.78) {
      const k = (t - 0.52) / 0.26;
      r = 26 + k * 224;
      g = 170 + k * 65;
      b = 205 - k * 165;
    } else {
      const k = (t - 0.78) / 0.22;
      r = 250;
      g = 235 - k * 185;
      b = 40 - k * 25;
    }
    lut[i * 3] = Math.round(r);
    lut[i * 3 + 1] = Math.round(g);
    lut[i * 3 + 2] = Math.round(b);
  }
  return lut;
})();

function hzToPct(hz: number): number {
  return ((clamp(hz, WF_MIN_HZ, WF_MAX_HZ) - WF_MIN_HZ) / (WF_MAX_HZ - WF_MIN_HZ)) * 100;
}

function pctToHz(pct: number): number {
  return Math.round(WF_MIN_HZ + clamp(pct, 0, 1) * (WF_MAX_HZ - WF_MIN_HZ));
}

function dbToLutIndex(db: number): number {
  const norm = clamp((db + 92) / 72, 0, 1);
  return Math.floor(norm * 255);
}

const RULER_TICKS: Array<{ hz: number; pct: number; major: boolean }> = (() => {
  const arr: Array<{ hz: number; pct: number; major: boolean }> = [];
  for (let hz = WF_MIN_HZ; hz <= WF_MAX_HZ; hz += 100) {
    arr.push({ hz, pct: hzToPct(hz), major: hz % 200 === 0 });
  }
  return arr;
})();

export function ModernWaterfall({
  frames,
  rxHz,
  txHz,
  txEnabled,
  evenOccupiedHz,
  oddOccupiedHz,
  activeQsos,
  identities,
  rosterFreqMap,
  onChangeRxHz,
  onCommitTxHz,
}: Props) {
  const { hover } = useCrossHighlight();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wfCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const ovCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [size, setSize] = useState<{ w: number; h: number }>({ w: 680, h: 112 });
  const [dragTxHz, setDragTxHz] = useState<number | null>(null);
  const dragModeRef = useRef<"rx" | "tx" | null>(null);
  const dragTxRef = useRef<number | null>(null);

  const displayTxHz = dragTxHz ?? txHz;
  const latestFrame = frames.length > 0 ? frames[frames.length - 1] : null;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const measure = () => {
      const rect = stage.getBoundingClientRect();
      const w = Math.max(240, Math.floor(rect.width));
      const h = Math.max(88, Math.floor(rect.height));
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };

    measure();
    window.addEventListener("resize", measure);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(stage);
    }
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);

  // Draw live backend FFT waterfall frames
  useEffect(() => {
    const canvas = wfCanvasRef.current;
    if (!canvas) return;
    if (canvas.width !== size.w || canvas.height !== size.h) {
      canvas.width = size.w;
      canvas.height = size.h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = size.w;
    const h = size.h;
    ctx.fillStyle = "#050912";
    ctx.fillRect(0, 0, w, h);

    if (frames.length === 0) return;

    const rowH = 2;
    const occStripH = 5;
    const plotH = Math.max(20, h - occStripH);
    const maxRows = Math.ceil(plotH / rowH);
    const hzSpan = WF_MAX_HZ - WF_MIN_HZ;

    for (let row = 0; row < maxRows; row++) {
      const frameIdx = frames.length - 1 - row;
      if (frameIdx < 0) break;
      const frame = frames[frameIdx];
      const bins = frame.bins_db;
      if (!bins || bins.length === 0) continue;

      const y = row * rowH;
      const fMin = frame.min_hz || WF_MIN_HZ;
      const fMax = frame.max_hz || WF_MAX_HZ;
      const binSpan = fMax - fMin > 0 ? fMax - fMin : hzSpan;

      for (let b = 0; b < bins.length; b++) {
        const hz0 = fMin + (b / bins.length) * binSpan;
        const hz1 = fMin + ((b + 1) / bins.length) * binSpan;
        const x0 = Math.floor(((hz0 - WF_MIN_HZ) / hzSpan) * w);
        const x1 = Math.ceil(((hz1 - WF_MIN_HZ) / hzSpan) * w);
        if (x1 <= 0 || x0 >= w) continue;

        const idx = dbToLutIndex(bins[b]);
        const r = COLOR_LUT[idx * 3];
        const g = COLOR_LUT[idx * 3 + 1];
        const bCol = COLOR_LUT[idx * 3 + 2];
        ctx.fillStyle = `rgb(${r},${g},${bCol})`;
        ctx.fillRect(Math.max(0, x0), y, Math.max(1, x1 - x0), rowH);
      }
    }

    // Bottom occupancy strip (even=cyan, odd=amber)
    const occY = h - occStripH;
    ctx.fillStyle = "#090e19";
    ctx.fillRect(0, occY, w, occStripH);
    for (const hz of evenOccupiedHz) {
      const x1 = ((hz - 25 - WF_MIN_HZ) / hzSpan) * w;
      const x2 = ((hz + 25 - WF_MIN_HZ) / hzSpan) * w;
      ctx.fillStyle = "rgba(56, 189, 248, 0.78)";
      ctx.fillRect(x1, occY + 1, Math.max(3, x2 - x1), 2);
    }
    for (const hz of oddOccupiedHz) {
      const x1 = ((hz - 25 - WF_MIN_HZ) / hzSpan) * w;
      const x2 = ((hz + 25 - WF_MIN_HZ) / hzSpan) * w;
      ctx.fillStyle = "rgba(245, 158, 11, 0.78)";
      ctx.fillRect(x1, occY + 3, Math.max(3, x2 - x1), 2);
    }
  }, [frames, size, evenOccupiedHz, oddOccupiedHz]);

  // Draw RX/TX guide tracks + Hover Beam overlay
  useEffect(() => {
    const ov = ovCanvasRef.current;
    if (!ov) return;
    if (ov.width !== size.w || ov.height !== size.h) {
      ov.width = size.w;
      ov.height = size.h;
    }
    const ctx = ov.getContext("2d");
    if (!ctx) return;

    const w = size.w;
    const h = size.h;
    const hzSpan = WF_MAX_HZ - WF_MIN_HZ;
    const bwPx = Math.max(6, (50 / hzSpan) * w);

    ctx.clearRect(0, 0, w, h);

    // RX green track
    const rxX = ((rxHz - WF_MIN_HZ) / hzSpan) * w;
    ctx.fillStyle = "rgba(34, 197, 94, 0.08)";
    ctx.fillRect(rxX - bwPx / 2, 0, bwPx, h);
    ctx.strokeStyle = "rgba(34, 197, 94, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rxX - bwPx / 2, 0);
    ctx.lineTo(rxX - bwPx / 2, h);
    ctx.moveTo(rxX + bwPx / 2, 0);
    ctx.lineTo(rxX + bwPx / 2, h);
    ctx.stroke();

    // TX red track
    const txX = ((displayTxHz - WF_MIN_HZ) / hzSpan) * w;
    ctx.fillStyle = txEnabled
      ? "rgba(239, 68, 68, 0.11)"
      : "rgba(239, 68, 68, 0.04)";
    ctx.fillRect(txX - bwPx / 2, 0, bwPx, h);
    ctx.strokeStyle = txEnabled
      ? "rgba(239, 68, 68, 0.7)"
      : "rgba(239, 68, 68, 0.35)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(txX - bwPx / 2, 0);
    ctx.lineTo(txX - bwPx / 2, h);
    ctx.moveTo(txX + bwPx / 2, 0);
    ctx.lineTo(txX + bwPx / 2, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Vertical Hover Beam
    if (hover.hoveredCallsign && hover.hoveredFreqHz) {
      const hx = ((hover.hoveredFreqHz - WF_MIN_HZ) / hzSpan) * w;
      const beamColor = hover.hoveredColor || "#38bdf8";
      const beamW = Math.max(bwPx + 8, 18);

      const grad = ctx.createLinearGradient(hx - beamW, 0, hx + beamW, 0);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, hexToRgba(beamColor, 0.38));
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(hx - beamW, 0, beamW * 2, h);

      ctx.strokeStyle = beamColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, h);
      ctx.stroke();

      const label = `${hover.hoveredCallsign} · ${hover.hoveredFreqHz} Hz`;
      ctx.font =
        "bold 10.5px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      const tw = ctx.measureText(label).width;
      const padX = 7;
      const boxW = tw + padX * 2;
      const boxH = 19;
      const boxX = clamp(hx - boxW / 2, 6, w - boxW - 6);
      const boxY = 7;

      ctx.fillStyle = "rgba(8, 12, 19, 0.92)";
      ctx.strokeStyle = beamColor;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(boxX, boxY, boxW, boxH, 5);
      } else {
        ctx.rect(boxX, boxY, boxW, boxH);
      }
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.fillText(label, boxX + padX, boxY + boxH / 2 + 0.5);
    }
  }, [hover, rxHz, displayTxHz, txEnabled, size]);

  // Global drag tracking for RX/TX handles
  useEffect(() => {
    const computeHz = (clientX: number): number | null => {
      const stage = stageRef.current;
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const pct = (clientX - rect.left) / rect.width;
      return clamp(
        Math.round(pctToHz(pct) / 5) * 5,
        WF_MIN_HZ + 25,
        WF_MAX_HZ - 25
      );
    };

    const onPointerMove = (e: PointerEvent) => {
      const mode = dragModeRef.current;
      if (!mode) return;
      const hz = computeHz(e.clientX);
      if (hz === null) return;
      if (mode === "tx") {
        dragTxRef.current = hz;
        setDragTxHz(hz);
      } else {
        onChangeRxHz(hz);
      }
    };

    const onPointerUp = () => {
      const mode = dragModeRef.current;
      if (!mode) return;
      dragModeRef.current = null;
      if (mode === "tx") {
        const finalHz = dragTxRef.current;
        dragTxRef.current = null;
        setDragTxHz(null);
        if (finalHz !== null) {
          onCommitTxHz(finalHz);
        }
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [onChangeRxHz, onCommitTxHz]);

  const pointerSetFreq = (clientX: number, mode: "rx" | "tx") => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return;
    const pct = (clientX - rect.left) / rect.width;
    const hz = clamp(
      Math.round(pctToHz(pct) / 5) * 5,
      WF_MIN_HZ + 25,
      WF_MAX_HZ - 25
    );
    dragModeRef.current = mode;
    if (mode === "tx") {
      dragTxRef.current = hz;
      setDragTxHz(hz);
    } else {
      onChangeRxHz(hz);
    }
  };

  const bwPct = (50 / (WF_MAX_HZ - WF_MIN_HZ)) * 100;
  const rxPct = hzToPct(rxHz);
  const txPct = hzToPct(displayTxHz);

  // Compute diamonds for active QSOs with known AF offset
  const qsoDiamonds: Array<{
    qsoId: string;
    badge: string;
    callsign: string;
    color: string;
    hz: number;
  }> = [];
  for (const q of activeQsos) {
    if (q.is_cq) continue;
    const id = identities.get(q.qso_id);
    if (!id) continue;
    const transcript = q.transcript ?? [];
    let rxAf: number | null = null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].direction === "rx" && transcript[i].af_hz > 0) {
        rxAf = transcript[i].af_hz;
        break;
      }
    }
    const callNorm = normalizeCall(q.their_call);
    const hz = rxAf ?? rosterFreqMap.get(callNorm) ?? null;
    if (hz !== null) {
      qsoDiamonds.push({
        qsoId: q.qso_id,
        badge: id.badge,
        callsign: callNorm,
        color: id.color,
        hz,
      });
    }
  }

  return (
    <div class="mft8-waterfall-wrap">
      <div
        class="mft8-wf-ruler"
        title="Click to set RX · Shift+Click to set TX · Drag handles"
        onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          const bracket = target.closest<HTMLElement>("[data-drag]");
          if (bracket) {
            const dragType = bracket.getAttribute("data-drag") as "rx" | "tx";
            e.preventDefault();
            dragModeRef.current = dragType;
            if (dragType === "tx") {
              dragTxRef.current = displayTxHz;
              setDragTxHz(displayTxHz);
            }
            return;
          }
          if (target.closest("[data-callsign]")) return;
          pointerSetFreq(e.clientX, e.shiftKey ? "tx" : "rx");
        }}
      >
        {RULER_TICKS.map((t) => (
          <div key={t.hz}>
            <div
              style={{
                position: "absolute",
                left: `${t.pct.toFixed(3)}%`,
                bottom: 0,
                width: "1px",
                height: t.major ? "8px" : "4px",
                background: t.major ? "#475569" : "#253247",
                pointerEvents: "none",
              }}
            />
            {t.major && t.hz > WF_MIN_HZ && t.hz < WF_MAX_HZ && (
              <span
                class="mft8-mono"
                style={{
                  position: "absolute",
                  left: `${t.pct.toFixed(3)}%`,
                  top: "2px",
                  transform: "translateX(-50%)",
                  fontSize: "9px",
                  color: "#64748b",
                  pointerEvents: "none",
                }}
              >
                {t.hz}
              </span>
            )}
          </div>
        ))}

        {qsoDiamonds.map((d) => (
          <div
            key={d.qsoId}
            class="mft8-wf-qso-diamond"
            data-callsign={d.callsign}
            data-hz={d.hz}
            data-color={d.color}
            title={`${d.badge} ${d.callsign} (${d.hz} Hz)`}
            style={{
              left: `${hzToPct(d.hz).toFixed(3)}%`,
              background: d.color,
              boxShadow: `0 0 6px ${d.color}`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onChangeRxHz(d.hz);
            }}
          />
        ))}

        <div
          class="mft8-wf-bracket mft8-wf-bracket-rx"
          data-testid="mft8-rx-bracket"
          data-drag="rx"
          style={{
            left: `${rxPct.toFixed(3)}%`,
            width: `${Math.max(bwPct, 1.8).toFixed(3)}%`,
          }}
        >
          <span class="mft8-wf-bracket-label">RX {rxHz}</span>
        </div>

        <div
          class="mft8-wf-bracket mft8-wf-bracket-tx"
          data-testid="mft8-tx-bracket"
          data-drag="tx"
          style={{
            left: `${txPct.toFixed(3)}%`,
            width: `${Math.max(bwPct, 1.8).toFixed(3)}%`,
          }}
        >
          <span class="mft8-wf-bracket-label">TX {displayTxHz}</span>
        </div>
      </div>

      <div
        ref={stageRef}
        class="mft8-wf-stage"
        data-testid="mft8-wf-stage"
        title="Click to set RX · Shift+Click to set TX"
        onPointerDown={(e) => {
          pointerSetFreq(e.clientX, e.shiftKey ? "tx" : "rx");
        }}
      >
        <canvas
          ref={wfCanvasRef}
          class="mft8-wf-canvas"
          data-testid="mft8-waterfall-canvas"
        />
        <canvas
          ref={ovCanvasRef}
          class="mft8-wf-overlay"
          data-testid="mft8-waterfall-overlay"
        />
        {frames.length === 0 && (
          <div class="mft8-wf-empty">
            Start a session to stream live 200–3000 Hz RF spectrum
          </div>
        )}
        <div class="mft8-wf-hint">
          {latestFrame
            ? `RMS ${latestFrame.rms_db.toFixed(1)} · Peak ${latestFrame.peak_db.toFixed(1)} dBFS${
                latestFrame.clipped ? " · CLIP!" : ""
              } · `
            : ""}
          Click: RX · Shift+Click: TX · Drag Brackets
        </div>
      </div>
    </div>
  );
}
