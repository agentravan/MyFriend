"use client";
// Live microphone loudness (0..1) for the visualizer. Skipped on Android, where a second mic stream can break speech recognition.
import { useEffect, useRef } from "react";

export function useMicLevel(active: boolean) {
  const level = useRef(0);
  useEffect(() => {
    if (!active || /Android/i.test(navigator.userAgent) || !navigator.mediaDevices?.getUserMedia) return;
    let stop = false, raf = 0, stream: MediaStream | null = null, ctx: AudioContext | null = null;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((s) => {
      if (stop) return s.getTracks().forEach((t) => t.stop());
      stream = s; ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2;
        level.current = Math.min(1, Math.sqrt(sum / buf.length) * 5);
        raf = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => null);
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); ctx?.close(); level.current = 0; };
  }, [active]);
  return level;
}
