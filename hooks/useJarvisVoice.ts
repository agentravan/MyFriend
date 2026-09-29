"use client";
// NOVA voice: wake word "NOVA" (hi-IN recognition, Hinglish-friendly) + FRIDAY-style female voice.
// Speech output: Gemini neural voice (via /api/tts) when enabled, else the best female device voice
// (Neerja/Swara natural on Edge, Zira like FRIDAY on Windows, Google हिन्दी/UK Female on Chrome/Android).
import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceMode = "off" | "sleeping" | "awake" | "speaking";
export type VoicePrefs = { neural: boolean; neuralVoice: string; deviceVoice: string; rate: number; lang?: "en-IN" | "hi-IN" };
const WAKE = /(^|[\s,.!?])(nova|novaa|nowa|नोवा|नोवाह|नोबा|नोव)(?=$|[\s,.!?])/i;
// FRIDAY used Windows voices[1] = "Microsoft Zira" (female). Prefer natural female voices first.
const FEMALE = [/Neerja/i, /Swara/i, /Heera/i, /Zira/i, /Google हिन्दी/i, /Google UK English Female/i, /Aria|Jenny|Sonia|Libby/i, /Samantha|Veena|Lekha/i, /female/i];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function pickVoice(vs: SpeechSynthesisVoice[], wanted?: string, deva = false) {
  if (wanted) { const v = vs.find((x) => x.name === wanted); if (v) return v; }
  const pool = deva ? vs.filter((v) => v.lang.startsWith("hi")) : vs.filter((v) => /^en-(IN|GB|US)|^hi/.test(v.lang));
  for (const re of FEMALE) { const v = pool.find((x) => re.test(x.name)) ?? vs.find((x) => re.test(x.name)); if (v) return v; }
  return pool[0] ?? vs[0] ?? null;
}

export function greeting() {
  const h = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }));
  const part = h < 5 ? "Working late, Boss" : h < 12 ? "Good morning, Boss" : h < 17 ? "Good afternoon, Boss" : h < 21 ? "Good evening, Boss" : "Good night, Boss";
  return `${part}. This is NOVA. How may I help you?`;
}

export function useJarvisVoice(onCommand: (text: string) => void, prefs: VoicePrefs, { awakeMs = 20000 } = {}) {
  // en-IN writes Hinglish in Roman script and keeps English words intact ("manufacturing", not "मीना फ्रैक्चर").
  const lang = prefs.lang ?? "en-IN";
  const [mode, setMode] = useState<VoiceMode>("off");
  const [interim, setInterim] = useState("");
  const [supported, setSupported] = useState(true);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const rec = useRef<Any>(null), armed = useRef(false), speaking = useRef(false), awakeUntil = useRef(0);
  const level = useRef(0), audioRef = useRef<HTMLAudioElement | null>(null), ctxRef = useRef<AudioContext | null>(null);
  const cb = useRef(onCommand), prefsRef = useRef(prefs);
  cb.current = onCommand; prefsRef.current = prefs;

  const wake = useCallback(() => { awakeUntil.current = Date.now() + awakeMs; setMode("awake"); }, [awakeMs]);
  const listen = () => { try { rec.current?.start(); } catch { /* already running */ } };

  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices() ?? []);
    load(); window.speechSynthesis?.addEventListener?.("voiceschanged", load);
    const SR = (window as Any).SpeechRecognition || (window as Any).webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = lang;
    r.onresult = (e: Any) => {
      if (speaking.current) return;
      let fin = "", mid = "";
      for (let i = e.resultIndex; i < e.results.length; i++)
        (e.results[i].isFinal ? (fin += e.results[i][0].transcript) : (mid += e.results[i][0].transcript));
      const awake = Date.now() < awakeUntil.current;
      setInterim(mid);
      if (!awake && WAKE.test(mid)) wake();
      if (!fin.trim() || !(awake || WAKE.test(fin))) return;
      const cmd = fin.replace(WAKE, " ").trim();
      if (cmd.length > 1) { setInterim(""); awakeUntil.current = Date.now() + awakeMs; cb.current(cmd); } else wake();
    };
    r.onend = () => { if (armed.current && !speaking.current) listen(); };
    if (armed.current) setTimeout(listen, 200); // language switched while listening → resume
    r.onerror = (e: Any) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { armed.current = false; setMode("off"); } };
    rec.current = r;
    const tick = setInterval(() => { if (armed.current && !speaking.current) setMode(Date.now() < awakeUntil.current ? "awake" : "sleeping"); }, 400);
    return () => { clearInterval(tick); armed.current = false; r.abort(); window.speechSynthesis?.removeEventListener?.("voiceschanged", load); };
  }, [lang, awakeMs, wake]);

  const done = useCallback(() => {
    speaking.current = false; level.current = 0;
    if (armed.current) { awakeUntil.current = Date.now() + awakeMs; setMode("awake"); listen(); } else setMode("off");
  }, [awakeMs]);

  const deviceSpeak = useCallback((text: string) => {
    const s = window.speechSynthesis; if (!s) return done();
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const deva = /[ऀ-ॿ]/.test(text);
    u.voice = pickVoice(s.getVoices(), prefsRef.current.deviceVoice, deva);
    u.lang = u.voice?.lang ?? (deva ? "hi-IN" : "en-IN");
    u.rate = prefsRef.current.rate || 1; u.pitch = 1.05;
    let t = 0; const iv = setInterval(() => { t++; level.current = 0.3 + 0.35 * Math.abs(Math.sin(t / 2.3) * Math.sin(t / 5)); }, 60);
    u.onend = u.onerror = () => { clearInterval(iv); done(); };
    s.speak(u);
  }, [done]);

  const speak = useCallback(async (raw: string) => {
    const text = raw.replace(/[*#_`>|]/g, "").replace(/https?:\/\/\S+/g, "link").slice(0, 700);
    if (!text.trim()) return;
    speaking.current = true; setMode("speaking");
    try { rec.current?.abort(); } catch { /* noop */ }
    audioRef.current?.pause(); window.speechSynthesis?.cancel();
    if (!prefsRef.current.neural) return deviceSpeak(text);
    try {
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice: prefsRef.current.neuralVoice }) });
      if (!r.ok) throw new Error("tts");
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url); audioRef.current = a;
      // Drive the core from the real voice signal
      try {
        const ctx = ctxRef.current ?? (ctxRef.current = new AudioContext());
        const src = ctx.createMediaElementSource(a), an = ctx.createAnalyser(); an.fftSize = 512;
        src.connect(an); an.connect(ctx.destination);
        const buf = new Uint8Array(an.fftSize);
        const loop = () => { if (a.paused || a.ended) return; an.getByteTimeDomainData(buf);
          let sum = 0; for (const v of buf) sum += ((v - 128) / 128) ** 2; level.current = Math.min(1, Math.sqrt(sum / buf.length) * 4); requestAnimationFrame(loop); };
        a.onplay = loop;
      } catch { /* visual only */ }
      a.onended = a.onerror = () => { URL.revokeObjectURL(url); done(); };
      await a.play();
    } catch { deviceSpeak(text); }
  }, [deviceSpeak, done]);

  const stopSpeaking = useCallback(() => { audioRef.current?.pause(); window.speechSynthesis?.cancel(); done(); }, [done]);
  const start = useCallback(() => { armed.current = true; setMode("sleeping"); listen(); }, []);
  const stop = useCallback(() => { armed.current = false; awakeUntil.current = 0; rec.current?.stop(); setMode("off"); }, []);
  const trigger = useCallback(() => { if (!armed.current) start(); wake(); }, [start, wake]);

  return { mode, interim, supported, voices, level, start, stop, trigger, speak, stopSpeaking };
}
