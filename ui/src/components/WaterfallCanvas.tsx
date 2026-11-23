import { useEffect, useRef } from "preact/hooks";
import type { WaterfallEvent } from "../types";

interface Props {
  frames: WaterfallEvent[];
  txAfHz: number;
  evenOccupiedHz: number[];
  oddOccupiedHz: number[];
  onSelectAf: (afHz: number) => void;
}

const MIN_HZ = 200;
const MAX_HZ = 3000;

function dbToRgb(db: number): [number, number, number] {
  const norm = Math.max(0, Math.min(1, (db + 90) / 70));
  if (norm < 0.35) {
    const t = norm / 0.35;
    return [10, Math.round(25 + t * 80), Math.round(45 + t * 140)];
  }
  if (norm < 0.7) {
    const t = (norm - 0.35) / 0.35;
    return [Math.round(10 + t * 235), Math.round(105 + t * 125), Math.round(185 - t * 140)];
  }
  const t = (norm - 0.7) / 0.3;
  return [245, Math.round(230 - t * 180), Math.round(45 - t * 30)];
}

export function WaterfallCanvas({
  frames,
  txAfHz,
  evenOccupiedHz,
  oddOccupiedHz,
  onSelectAf,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latest = frames.length > 0 ? frames[frames.length - 1] : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const rulerH = 22;
    const occH = 16;
    const plotTop = rulerH;
    const plotH = h - rulerH - occH;

    ctx.fillStyle = "#080d16";
    ctx.fillRect(0, 0, w, h);

    // Draw waterfall history (newest at top)
    const rowH = Math.max(2, Math.floor(plotH / 64));
    for (let idx = 0; idx < frames.length; idx++) {
      const f = frames[frames.length - 1 - idx];
      const y = plotTop + idx * rowH;
      if (y >= plotTop + plotH) break;
      const bins = f.bins_db;
      if (!bins || bins.length === 0) continue;
      const binW = w / bins.length;
      for (let b = 0; b < bins.length; b++) {
        const [r, g, bl] = dbToRgb(bins[b]);
        ctx.fillStyle = `rgb(${r},${g},${bl})`;
        ctx.fillRect(b * binW, y, Math.ceil(binW), rowH);
      }
    }

    // Frequency ruler
    ctx.fillStyle = "#111927";
    ctx.fillRect(0, 0, w, rulerH);
    ctx.strokeStyle = "#263449";
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px ui-monospace, monospace";
    for (let hz = 500; hz <= 2500; hz += 500) {
      const x = ((hz - MIN_HZ) / (MAX_HZ - MIN_HZ)) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rulerH);
      ctx.stroke();
      ctx.fillText(`${hz}`, x + 4, 14);
    }

    // Occupancy strip (Even = blue #38bdf8, Odd = amber #f59e0b)
    const occTop = plotTop + plotH;
    ctx.fillStyle = "#0d1522";
    ctx.fillRect(0, occTop, w, occH);
    for (const hz of evenOccupiedHz) {
      const x1 = ((hz - 25 - MIN_HZ) / (MAX_HZ - MIN_HZ)) * w;
      const x2 = ((hz + 25 - MIN_HZ) / (MAX_HZ - MIN_HZ)) * w;
      ctx.fillStyle = "rgba(56, 189, 248, 0.8)";
      ctx.fillRect(x1, occTop + 2, Math.max(4, x2 - x1), 5);
    }
    for (const hz of oddOccupiedHz) {
      const x1 = ((hz - 25 - MIN_HZ) / (MAX_HZ - MIN_HZ)) * w;
      const x2 = ((hz + 25 - MIN_HZ) / (MAX_HZ - MIN_HZ)) * w;
      ctx.fillStyle = "rgba(245, 158, 11, 0.75)";
      ctx.fillRect(x1, occTop + 9, Math.max(4, x2 - x1), 5);
    }

    // TX AF marker crosshair (+/- 25 Hz span)
    const txX = ((txAfHz - MIN_HZ) / (MAX_HZ - MIN_HZ)) * w;
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(txX, rulerH);
    ctx.lineTo(txX, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fca5a5";
    ctx.fillText(`TX ${txAfHz}`, Math.min(w - 58, Math.max(4, txX + 4)), rulerH + 13);
  }, [frames, txAfHz, evenOccupiedHz, oddOccupiedHz]);

  const handleClick = (e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const hz = Math.round(MIN_HZ + frac * (MAX_HZ - MIN_HZ));
    onSelectAf(Math.max(MIN_HZ, Math.min(MAX_HZ, hz)));
  };

  return (
    <div class="waterfall-wrap">
      <div class="waterfall-meta mono">
        <span>Passband 200–3000 Hz (click to set TX AF)</span>
        <span>
          RMS: {latest ? `${latest.rms_db.toFixed(1)} dBFS` : "—"} · Peak:{" "}
          {latest ? `${latest.peak_db.toFixed(1)} dBFS` : "—"}
          {latest?.clipped ? " · CLIP!" : ""}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="waterfall-canvas"
        class="waterfall-canvas"
        width={840}
        height={176}
        onClick={handleClick}
      />
      <div class="waterfall-legend muted">
        <span><i class="swatch swatch-even" /> Even slot occupied</span>
        <span><i class="swatch swatch-odd" /> Odd slot occupied</span>
        <span><i class="swatch swatch-tx" /> Selected TX AF ({txAfHz} Hz)</span>
      </div>
    </div>
  );
}
