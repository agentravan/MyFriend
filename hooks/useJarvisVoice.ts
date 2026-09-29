"use client";
// Browser-native wake word + continuous bilingual (Hinglish/English) voice loop. Chrome/Edge only.
import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceMode = "off" | "sleeping" | "awake" | "speaking";
// "NOVA" as recognised in hi-IN (often returned in Devanagari) or en-IN.
const WAKE = /(^|[\s,.!?])(nova|novaa|nowa|नोवा|नोवाह|नोबा|नोव)(?=$|[\s,.!?])/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function useJarvisVoice(onCommand: (text: string) => void, { lang = "hi-IN", awakeMs = 20000 } = {}) {
  const [mode, setMode] = useState<VoiceMode>("off");
  const [interim, setInterim] = useState("");
  const [supported, setSupported] = useState(true);
  const rec = useRef<Any>(null), armed = useRef(false), speaking = useRef(false), awakeUntil = useRef(0);
  const cb = useRef(onCommand);
  cb.current = onCommand;

  const wake = useCallback(() => { awakeUntil.current = Date.now() + awakeMs; setMode("awake"); }, [awakeMs]);
  const listen = () => { try { rec.current?.start(); } catch { /* already running */ } };

  useEffect(() => {
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
      if (!awake && WAKE.test(mid)) wake(); // instant feedback while still speaking
      if (!fin.trim() || !(awake || WAKE.test(fin))) return; // ignore chatter while asleep
      const cmd = fin.replace(WAKE, " ").trim();
      if (cmd.length > 1) { setInterim(""); awakeUntil.current = Date.now() + awakeMs; cb.current(cmd); }
      else wake(); // just "NOVA" → wait for the command
    };
    r.onend = () => { if (armed.current && !speaking.current) listen(); }; // Chrome stops every ~60s; keep alive
    r.onerror = (e: Any) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { armed.current = false; setMode("off"); } };
    rec.current = r;
    const tick = setInterval(() => {
      if (armed.current && !speaking.current) setMode(Date.now() < awakeUntil.current ? "awake" : "sleeping");
    }, 400);
    return () => { clearInterval(tick); armed.current = false; r.abort(); };
  }, [lang, awakeMs, wake]);

  const start = useCallback(() => { armed.current = true; setMode("sleeping"); listen(); }, []);
  const stop = useCallback(() => { armed.current = false; awakeUntil.current = 0; rec.current?.stop(); setMode("off"); }, []);
  /** Manual trigger (button / hotkey): arm if needed and wake immediately. */
  const trigger = useCallback(() => { if (!armed.current) start(); wake(); }, [start, wake]);

  const speak = useCallback((text: string) => {
    const s = window.speechSynthesis;
    if (!s || !text) return;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*#_`>]/g, "").slice(0, 600));
    const vs = s.getVoices(), deva = /[ऀ-ॿ]/.test(text);
    u.voice = (deva ? vs.find((v) => v.lang === "hi-IN") : vs.find((v) => v.lang === "en-IN"))
      ?? vs.find((v) => v.lang.startsWith("hi") || v.lang === "en-IN") ?? null;
    u.lang = u.voice?.lang ?? (deva ? "hi-IN" : "en-IN");
    u.rate = 1.03;
    speaking.current = true; setMode("speaking");
    try { rec.current?.abort(); } catch { /* noop */ } // don't hear ourselves
    u.onend = u.onerror = () => {
      speaking.current = false;
      if (armed.current) { awakeUntil.current = Date.now() + awakeMs; setMode("awake"); listen(); } else setMode("off");
    };
    s.speak(u);
  }, [awakeMs]);

  return { mode, interim, supported, start, stop, trigger, speak };
}
