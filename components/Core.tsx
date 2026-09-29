"use client";
// NOVA neural core: canvas-rendered, reacts to voice level and state. ~60fps, DPR-aware, pauses when hidden.
import { useEffect, useRef } from "react";

export type CoreMode = "off" | "sleeping" | "awake" | "speaking" | "thinking";
const COLORS: Record<CoreMode, [number, number, number]> = {
  off: [70, 110, 130], sleeping: [64, 214, 255], awake: [255, 154, 46], speaking: [255, 170, 60], thinking: [169, 139, 255],
};

export default function Core({ mode, level, onClick, size = 300 }: { mode: CoreMode; level: React.RefObject<number>; onClick?: () => void; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null), modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const cv = ref.current!, ctx = cv.getContext("2d")!;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = cv.height = size * dpr; ctx.scale(dpr, dpr);
    const C = size / 2, parts = Array.from({ length: 70 }, () => ({ a: Math.random() * 6.28, r: 0.62 + Math.random() * 0.36, s: 0.001 + Math.random() * 0.004, z: Math.random() }));
    let col = [...COLORS.sleeping], lv = 0, raf = 0, t = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      t += 1;
      const m = modeRef.current, target = COLORS[m];
      col = col.map((c, i) => c + (target[i] - c) * 0.06);
      const raw = level.current ?? 0;
      const synth = m === "speaking" ? 0.35 + 0.3 * Math.abs(Math.sin(t / 5) * Math.sin(t / 13)) : m === "thinking" ? 0.25 + 0.15 * Math.sin(t / 8) : 0;
      lv += (Math.max(raw, synth) - lv) * 0.2;
      const rgb = (a: number) => `rgba(${col[0] | 0},${col[1] | 0},${col[2] | 0},${a})`;
      const speed = m === "thinking" ? 3 : m === "awake" || m === "speaking" ? 1.8 : m === "off" ? 0.3 : 1;

      ctx.clearRect(0, 0, size, size);
      // glow
      const g = ctx.createRadialGradient(C, C, 0, C, C, C);
      g.addColorStop(0, rgb(0.28 + lv * 0.3)); g.addColorStop(0.35, rgb(0.08)); g.addColorStop(1, rgb(0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);

      // segmented rotating rings
      const ring = (r: number, segs: number, gap: number, rot: number, w: number, a: number) => {
        ctx.lineWidth = w; ctx.strokeStyle = rgb(a);
        for (let i = 0; i < segs; i++) {
          const s = rot + (i / segs) * Math.PI * 2;
          ctx.beginPath(); ctx.arc(C, C, r, s, s + (Math.PI * 2) / segs - gap); ctx.stroke();
        }
      };
      ring(C * 0.92, 60, 0.05, (t / 900) * speed, 1, 0.35);
      ring(C * 0.8, 3, 0.9, (-t / 160) * speed, 3, 0.9);
      ring(C * 0.72, 12, 0.18, (t / 260) * speed, 6, 0.55);
      ring(C * 0.55, 2, 1.6, (t / 90) * speed, 2, 0.8);

      // voice waveform ring (radial bars)
      const bars = 96;
      ctx.lineWidth = 2;
      for (let i = 0; i < bars; i++) {
        const a = (i / bars) * Math.PI * 2;
        const n = Math.sin(i * 0.9 + t / 6) * Math.sin(i * 0.37 - t / 9);
        const h = 4 + Math.abs(n) * (6 + lv * 46);
        const r0 = C * 0.6;
        ctx.strokeStyle = rgb(0.25 + Math.abs(n) * 0.6);
        ctx.beginPath(); ctx.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0);
        ctx.lineTo(C + Math.cos(a) * (r0 + h), C + Math.sin(a) * (r0 + h)); ctx.stroke();
      }

      // orbiting particles
      for (const p of parts) {
        p.a += p.s * speed * (1 + lv * 2);
        const r = C * p.r, x = C + Math.cos(p.a) * r, y = C + Math.sin(p.a) * r * (0.92 + p.z * 0.08);
        ctx.fillStyle = rgb(0.25 + p.z * 0.6); ctx.beginPath(); ctx.arc(x, y, 0.6 + p.z * 1.6, 0, 6.28); ctx.fill();
      }

      // triangle reactor + core
      ctx.save(); ctx.translate(C, C); ctx.rotate((t / 400) * speed);
      ctx.strokeStyle = rgb(0.9); ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 - Math.PI / 2; ctx[i ? "lineTo" : "moveTo"](Math.cos(a) * C * 0.36, Math.sin(a) * C * 0.36); }
      ctx.closePath(); ctx.stroke(); ctx.restore();
      const cr = C * (0.2 + lv * 0.07 + (m === "sleeping" ? Math.sin(t / 40) * 0.01 : 0));
      const cg = ctx.createRadialGradient(C, C, 0, C, C, cr);
      cg.addColorStop(0, "rgba(255,255,255,0.95)"); cg.addColorStop(0.45, rgb(0.9)); cg.addColorStop(1, rgb(0));
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(C, C, cr, 0, 6.28); ctx.fill();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [size, level]);

  return <canvas ref={ref} onClick={onClick} className="core" style={{ width: size, height: size }} aria-label="NOVA core — tap to talk" role="button" />;
}
