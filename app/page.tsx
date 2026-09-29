"use client";
// NOVA — calm, single-screen assistant. Missions left · conversation centre · deliverables right. Everything else lives in Settings.
import { useCallback, useEffect, useRef, useState } from "react";
import { useJarvisVoice, greeting, pickVoice, VoicePrefs } from "@/hooks/useJarvisVoice";
import { useMicLevel } from "@/hooks/useMicLevel";
import Core, { CoreMode } from "@/components/Core";
import Boot from "@/components/Boot";
import ActionCard, { launch, via } from "@/components/ActionCard";
import { Action, INTERNAL } from "@/lib/actions";
import type { Snapshot } from "@/lib/db";
import type { Analysis } from "@/lib/market";

type View = "nova" | "missions" | "files";
type Sheet = "voice" | "phone" | "markets" | "money" | "memory" | "approvals" | "system" | null;
type Timer = { id: number; label: string; end: number };
type Attach = { name: string; text?: string; b64?: string };
type Confirm = { label: string; run: () => void } | null;

const inr = (n: number) => (n < 0 ? "−₹" : "₹") + Math.round(Math.abs(n)).toLocaleString("en-IN");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fmtIST = (d: string | number) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const kb = (n: number) => (n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const YES = /^(haan|ha|haa|han|yes|yep|ok|okay|kar do|bhej do|bhejo|uthao|utha lo|answer|open karo|khol do|go ahead|chalo)\b/i;
const NO = /^(nahi|nahin|no|cancel|rehne do|mat karo|kaat do|decline|reject)\b/i;
const ACTIVE = ["planning", "running"];
const AGENT_IC: Record<string, string> = { research: "🔎", business: "📈", hr: "🧾", data: "📊", coding: "⌨️", testing: "🧪", document: "📄", communication: "✉️", manual: "✋" };
const FILE_IC = (m: string) => (m.includes("html") ? "🖥️" : m.includes("csv") ? "📊" : m.includes("markdown") ? "📝" : "📁");
const SUGGEST = ["Find 20 clients for my payroll work", "Build an HR dashboard", "Aaj ka mausam?", "Mummy ko call karo"];
const CHECKS = ["Risk ≤ 1–2% of capital", "Stop-loss decided before entry", "Reward:risk ≥ 2:1", "I can explain WHY in one line", "Not revenge / FOMO"];
const NEURAL = ["Kore", "Aoede", "Despina", "Leda", "Zephyr"];

const ls = { get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v == null ? d : (JSON.parse(v) as T); } catch { return d; } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } } };
function beep(n = 2) {
  try { const ac = new AudioContext(); for (let i = 0; i < n; i++) { const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * 0.28;
    o.frequency.value = 740 + i * 180; o.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2); o.start(t); o.stop(t + 0.22); } } catch { /* no audio */ }
}
const notify = (title: string, body: string) => { if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, icon: "/icon.svg" }); };
async function call(url: string, body?: object) {
  const r = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (r.status === 401) { location.href = "/login"; throw new Error("auth"); }
  const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Request failed"); return j;
}

export default function Home() {
  const [s, setS] = useState<Snapshot | null>(null);
  const [health, setHealth] = useState<Record<string, string> | null>(null), [engine, setEngine] = useState("");
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [daily, setDaily] = useState(false);
  const [input, setInput] = useState(""), [view, setView] = useState<View>("nova"), [sheet, setSheet] = useState<Sheet>(null);
  const [talk, setTalk] = useState(true), [direct, setDirect] = useState(true), [mission, setMission] = useState(false);
  const [prefs, setPrefs] = useState<VoicePrefs>({ neural: true, neuralVoice: "Kore", deviceVoice: "", rate: 1 });
  const [live, setLive] = useState<{ actions: Action[]; auto: boolean; key: number } | null>(null);
  const [attach, setAttach] = useState<Attach | null>(null), [confirm, setConfirm] = useState<Confirm>(null);
  const [timers, setTimers] = useState<Timer[]>([]), [clock, setClock] = useState("");
  const [card, setCard] = useState<Analysis | null>(null), [checks, setChecks] = useState<boolean[]>([]), [thesis, setThesis] = useState("");
  const [reasons, setReasons] = useState<Record<number, string>>({}), [needInput, setNeedInput] = useState(""), [hookUrl, setHookUrl] = useState("");
  const speakRef = useRef<(t: string) => void>(() => {}), confirmRef = useRef<Confirm>(null), prevStatus = useRef<Record<number, string>>({});
  const ticking = useRef(false), greeted = useRef(false), fileRef = useRef<HTMLInputElement>(null), feedRef = useRef<HTMLDivElement>(null);
  confirmRef.current = confirm;

  useEffect(() => { setTalk(ls.get("nova_talk", true)); setDirect(ls.get("nova_direct", true)); setMission(ls.get("nova_mission", false)); setPrefs(ls.get("nova_voice", prefs)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const savePrefs = (p: VoicePrefs) => { setPrefs(p); ls.set("nova_voice", p); };
  const say = useCallback((t: string) => { if (talk) speakRef.current(t); }, [talk]);
  const apply = useCallback((j: { state?: Snapshot }) => { if (j?.state) setS(j.state); }, []);
  const run = useCallback(async (body: object, url = "/api/agent") => {
    setErr(""); try { const j = await call(url, body); apply(j); return j; } catch (e) { setErr((e as Error).message); }
  }, [apply]);
  const phoneOp = useCallback((op: string, extra: object = {}) => run({ action: "phone", op, ...extra }), [run]);

  // ── Commands: pending yes/no → mission → chat/action planner
  const send = useCallback(async (text: string) => {
    text = text.trim(); if (!text && !attach) return;
    setInput("");
    const c = confirmRef.current;
    if (c && YES.test(text)) { setConfirm(null); c.run(); say("Done, Boss."); return; }
    if (c && NO.test(text)) { setConfirm(null); say("Theek hai, cancel kar diya."); return; }
    setBusy(true); setView("nova");
    if (attach || mission) {
      setS((p) => p && { ...p, messages: [...p.messages, { role: "user", content: text || `📎 ${attach?.name}`, id: Date.now() }] });
      const j = await run({ action: "create", goal: text || `Summarize and analyze the attached file ${attach?.name}`, file: attach ?? undefined }, "/api/tasks");
      setAttach(null); setBusy(false); if (j) say(j.reply ?? "Sure Boss, I'm on it."); return;
    }
    setS((p) => p && { ...p, messages: [...p.messages, { role: "user", content: text, id: Date.now() }] });
    const j = await run({ action: "chat", text });
    setBusy(false); if (!j) return;
    if (j.card) { setCard(j.card); setChecks([]); setThesis(""); setSheet("markets"); }
    const acts: Action[] = j.actions ?? [];
    for (const a of acts) if (a.kind === "timer") setTimers((t) => [...t, { id: Date.now() + Math.random(), label: a.label || "Timer", end: Date.now() + a.seconds * 1000 }]);
    const sms = acts.find((a) => via(a) === "phone-confirm");
    if (sms && sms.kind === "sms") setConfirm({ label: `Send SMS to ${sms.name ?? sms.phone}: “${sms.text}”`, run: () => phoneOp("sms", { number: sms.phone, text: sms.text, name: sms.name }) });
    const ext = acts.find((a) => !INTERNAL.has(a.kind) && !via(a) && !(a.kind === "call" && !a.phone));
    const auto = !!ext && direct && launch(ext);
    if (ext && !auto) setConfirm({ label: "Open it?", run: () => launch(ext) });
    setLive(acts.length ? { actions: acts, auto, key: Date.now() } : null);
    if (j.reply) say(j.reply);
  }, [run, direct, say, attach, mission, phoneOp]);

  const v = useJarvisVoice(send, prefs);
  speakRef.current = v.speak;
  const mic = useMicLevel(v.mode === "sleeping" || v.mode === "awake");
  const level = useRef(0); // one stable ref for the core: NOVA's voice while speaking, your mic otherwise
  useEffect(() => { const iv = setInterval(() => { level.current = v.mode === "speaking" ? v.level.current : mic.current; }, 33); return () => clearInterval(iv); }, [v.mode, v.level, mic]);
  const wakeUp = () => { v.trigger(); if (!greeted.current) { greeted.current = true; setTimeout(() => say(greeting()), 150); } };

  // ── Boot
  useEffect(() => {
    call("/api/agent").then(async (j) => {
      apply(j);
      call("/api/agent?health=1").then((h) => { setHealth(h.health); setEngine(h.search); }).catch(() => null);
      if (j.state.digest?.day !== todayIST()) { setDaily(true); await run({ action: "daily" }); setDaily(false); }
    }).catch((e) => e.message !== "auth" && setErr(e.message));
  }, [run, apply]);

  // ── Missions: tick while active; poll; announce changes
  const active = (s?.tasks ?? []).some((t) => ACTIVE.includes(t.status));
  useEffect(() => {
    if (!active) return;
    let stop = false;
    (async () => { while (!stop) {
      if (!ticking.current) { ticking.current = true; try { apply(await call("/api/tasks", { action: "tick" })); } catch { await new Promise((r) => setTimeout(r, 4000)); } ticking.current = false; }
      await new Promise((r) => setTimeout(r, 800)); } })();
    const poll = setInterval(() => call("/api/agent").then(apply).catch(() => null), 4000);
    return () => { stop = true; clearInterval(poll); };
  }, [active, apply]);
  useEffect(() => {
    for (const t of s?.tasks ?? []) {
      const b = prevStatus.current[t.id];
      if (b && b !== t.status) {
        if (t.status === "completed") { beep(3); notify("✅ " + t.title, t.summary ?? "Ready"); say(`Boss, ${t.title} ready hai.`); }
        if (t.status === "waiting_user") { beep(); notify("✋ NOVA needs you", t.needs ?? ""); say(`Boss, ek manual step chahiye: ${t.needs ?? ""}`); }
        if (t.status === "failed") say(`Boss, ${t.title} mein dikkat aayi. Retry kar sakte hain.`);
      }
      prevStatus.current[t.id] = t.status;
    }
  }, [s?.tasks, say]);

  // ── Phone → NOVA: incoming call announcements (poll only when Phone Link is on)
  const linked = !!s?.phone?.linked;
  useEffect(() => {
    if (!linked) return;
    const iv = setInterval(() => call("/api/agent").then(apply).catch(() => null), 5000);
    return () => clearInterval(iv);
  }, [linked, apply]);
  const lastEvent = useRef(0);
  useEffect(() => {
    const e = s?.events?.[0];
    if (!e || e.id === lastEvent.current || Date.now() - Date.parse(e.at) > 60e3) return;
    lastEvent.current = e.id;
    if (e.type === "call") {
      const who = e.name || e.number || "Unknown number";
      beep(3); notify("📞 Incoming call", who);
      say(`Boss, ${who} ka call aa raha hai. Uthaun?`);
      setConfirm({ label: `Answer call from ${who}?`, run: () => phoneOp("answer") });
    }
    run({ action: "events_seen" });
  }, [s?.events, say, phoneOp, run]);

  // ── Clock, timers, reminders, wake lock, shortcuts
  useEffect(() => {
    const iv = setInterval(() => {
      setClock(new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }));
      setTimers((ts) => { const due = ts.filter((t) => t.end <= Date.now());
        for (const t of due) { beep(3); notify("⏱️ Timer", t.label); speakRef.current(`Boss, ${t.label} ka time ho gaya.`); }
        return due.length ? ts.filter((t) => t.end > Date.now()) : ts; });
    }, 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    const iv = setInterval(() => { for (const r of s?.reminders ?? []) if (Date.parse(r.due_at) <= Date.now()) {
      beep(3); notify("⏰ Reminder", r.text); speakRef.current(`Reminder, Boss: ${r.text}`); run({ action: "reminder_done", id: r.id }); } }, 15000);
    return () => clearInterval(iv);
  }, [s?.reminders, run]);
  useEffect(() => {
    if (v.mode === "off" || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock: { request: (t: string) => Promise<typeof lock> } }).wakeLock.request("screen").then((l) => (lock = l)).catch(() => null);
    return () => { lock?.release().catch(() => null); };
  }, [v.mode]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.altKey && e.key.toLowerCase() === "n") wakeUp(); if (e.key === "Escape") setSheet(null); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k); });
  useEffect(() => { feedRef.current?.scrollTo({ top: 1e6, behavior: "smooth" }); }, [s?.messages.length, live, busy]);

  async function pickFile(f?: File) {
    if (!f) return;
    if (/\.pdf$/i.test(f.name)) { const b = new Uint8Array(await f.arrayBuffer()); let bin = ""; b.forEach((x) => (bin += String.fromCharCode(x))); setAttach({ name: f.name, b64: btoa(bin) }); }
    else setAttach({ name: f.name, text: (await f.text()).slice(0, 60000) });
  }

  // ── Derived
  const tasks = s?.tasks ?? [], files = s?.files ?? [];
  const current = tasks.find((t) => t.status === "waiting_user") ?? tasks.find((t) => ACTIVE.includes(t.status));
  const curSteps = (s?.steps ?? []).filter((x) => x.task_id === current?.id);
  const pct = curSteps.length ? Math.round((curSteps.filter((x) => x.status === "done").length / curSteps.length) * 100) : 0;
  const waiting = tasks.filter((t) => t.status === "waiting_user");
  const brains = Object.entries(health ?? {}).filter(([k]) => !k.endsWith("_model"));
  const brainOk = brains.some(([, x]) => x === "ok");
  const mode: CoreMode = busy || daily ? "thinking" : active && v.mode === "off" ? "thinking" : v.mode;
  const status = busy ? "Thinking" : v.mode === "speaking" ? "Speaking" : v.mode === "awake" ? "Listening" : active ? String(current?.phase ?? "Working").split(" · ")[0]
    : v.mode === "sleeping" ? "Say “NOVA”" : "Standby";
  const msgs = (s?.messages ?? []).slice(-12);
  const vis = (x: View) => (view === x ? "" : "m-hide");
  const openSheet = (x: Sheet) => { setSheet(x); if (x === "phone") setHookUrl(""); };

  return (
    <main className="app">
      <Boot />
      {/* ───── Top bar ───── */}
      <header className="top">
        <div className="logo"><span className="dot" data-on={brainOk} />NOVA</div>
        <div className={`pill ${mode}`}>{status}</div>
        <div className="top-r">
          <span className="clock">{clock}</span>
          {linked && <span className="tag-ok" title="Phone Link connected">📱</span>}
          <button className={`chip-btn ${mission ? "on" : ""}`} onClick={() => { setMission(!mission); ls.set("nova_mission", !mission); }} title="Mission mode: every command becomes an autonomous mission">🎯 Mission</button>
          <button className="icon" onClick={() => { setTalk(!talk); ls.set("nova_talk", !talk); if (talk) v.stopSpeaking(); }} title={talk ? "Mute voice" : "Unmute voice"}>{talk ? "🔊" : "🔇"}</button>
          <button className="icon" onClick={() => openSheet("voice")} title="Settings">⚙</button>
        </div>
      </header>
      {err && <div className="banner bad" onClick={() => setErr("")}>{err} <b>✕</b></div>}
      {!err && health && !brainOk && <div className="banner bad" onClick={() => openSheet("system")}>AI brain offline — {brains.map(([k, x]) => `${k}: ${x}`).join(" · ") || "no keys"}. Tap for details.</div>}
      {confirm && <div className="banner ask"><span>{confirm.label}</span><span className="row">
        <button className="primary" onClick={() => { const c = confirm; setConfirm(null); c.run(); }}>Yes</button><button onClick={() => setConfirm(null)}>No</button></span></div>}

      <section className="grid">
        {/* ───── Missions ───── */}
        <aside className={`side ${vis("missions")}`}>
          <div className="card grow">
            <div className="card-h"><h2>Missions</h2><span>{tasks.filter((t) => ACTIVE.includes(t.status)).length} active</span></div>
            <div className="list">
              {!tasks.length && <p className="muted">Give NOVA a goal. It plans, researches, builds and delivers — you get the result.</p>}
              {tasks.map((t) => { const st = (s?.steps ?? []).filter((x) => x.task_id === t.id), d = st.filter((x) => x.status === "done").length;
                return <div key={t.id} className={`mission ${t.status}`}><i />
                  <div><b>{t.title}</b><small>{t.status === "completed" ? "Completed" : t.phase}{st.length && t.status !== "completed" ? ` · ${d}/${st.length}` : ""}</small>
                    {ACTIVE.includes(t.status) && st.length > 0 && <span className="bar"><span style={{ width: `${(d / st.length) * 100}%` }} /></span>}</div></div>; })}
            </div>
          </div>
          <nav className="modules">
            {([["markets", "📈", "Markets"], ["money", "₹", "Money"], ["memory", "🧠", "Memory"], ["approvals", "✓", "Ideas"], ["phone", "📱", "Phone"]] as [Sheet, string, string][])
              .map(([k, ic, l]) => <button key={l} onClick={() => openSheet(k)}><span>{ic}</span>{l}{k === "approvals" && !!s?.metrics.pending && <em>{s.metrics.pending}</em>}</button>)}
          </nav>
        </aside>

        {/* ───── Centre ───── */}
        <div className={`main ${vis("nova")}`}>
          <div className="hero">
            <Core mode={mode} level={level} onClick={wakeUp} size={200} />
            <p className="heard">{v.interim || (v.mode === "awake" ? "Listening, Boss…" : " ")}</p>
          </div>

          {current && (
            <div className={`now ${current.status}`}>
              <div className="now-h"><b>{current.title}</b><span>{pct}%</span></div>
              <div className="steps">{curSteps.map((x) => <span key={x.id} className={`step ${x.status}`} title={`${x.title} · ${x.status}`}>{AGENT_IC[x.agent] ?? "•"}</span>)}</div>
              <div className="now-f"><span>{current.phase}</span>
                {ACTIVE.includes(current.status) && <button className="link" onClick={() => run({ action: "cancel", id: current.id }, "/api/tasks")}>Stop</button>}</div>
            </div>
          )}

          <div className="feed" ref={feedRef}>
            {!msgs.length && <div className="empty"><p>Tap the core or say <b>“NOVA”</b>.</p>
              <div className="suggest">{SUGGEST.map((x) => <button key={x} onClick={() => send(x)}>{x}</button>)}</div></div>}
            {msgs.map((m, i) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <p>{m.content}</p>
                {i === msgs.length - 1 && m.role === "assistant" && live && <div className="acts">{live.actions.map((a, k) =>
                  <ActionCard key={live.key + "-" + k} a={a} auto={live.auto && a === live.actions.find((y) => !INTERNAL.has(y.kind) && !via(y))}
                    onContact={(name, phone) => run({ action: "contact", name, phone })}
                    onPhoneSend={(x) => { if (x.kind === "sms") { setConfirm(null); phoneOp("sms", { number: x.phone, text: x.text, name: x.name }); } }} />)}</div>}
              </div>
            ))}
            {busy && <div className="msg assistant"><span className="dots"><i /><i /><i /></span></div>}
          </div>

          <form className="composer" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <button type="button" className={`mic ${v.mode !== "off" ? "on" : ""}`} disabled={!v.supported}
              onClick={() => (v.mode === "off" ? (v.start(), wakeUp()) : v.stop())} title={v.supported ? "Voice on/off" : "Voice needs Chrome or Edge"}>{v.mode === "off" ? "🎙" : "◉"}</button>
            <input className="field" value={input} onChange={(e) => setInput(e.target.value)}
              placeholder={mission ? "Describe a goal — NOVA will plan and do it" : "Ask or command NOVA…"} />
            {attach && <span className="att">{attach.name}<button type="button" onClick={() => setAttach(null)}>✕</button></span>}
            <button type="button" className="icon" onClick={() => fileRef.current?.click()} title="Attach PDF / TXT / CSV">📎</button>
            <input ref={fileRef} type="file" hidden accept=".pdf,.txt,.md,.csv,.json" onChange={(e) => pickFile(e.target.files?.[0])} />
            <button className="send" disabled={busy || (!input.trim() && !attach)}>↑</button>
          </form>
        </div>

        {/* ───── Right: needs you + files ───── */}
        <aside className={`side ${vis("files")}`}>
          {waiting.map((t) => (
            <div key={t.id} className="card need">
              <div className="card-h"><h2>Needs you</h2><span>{t.title}</span></div>
              <p>{t.needs}</p>
              <input placeholder="Note (optional)" value={needInput} onChange={(e) => setNeedInput(e.target.value)} />
              <button className="primary" onClick={() => { run({ action: "resume", id: t.id, input: needInput }, "/api/tasks"); setNeedInput(""); say("Thanks Boss, continuing."); }}>Done — continue</button>
            </div>
          ))}
          {!!timers.length && <div className="card">{timers.map((t) => { const l = Math.max(0, Math.round((t.end - Date.now()) / 1000));
            return <p key={t.id} className="timer"><b>{Math.floor(l / 60)}:{String(l % 60).padStart(2, "0")}</b> {t.label}</p>; })}</div>}
          <div className="card grow">
            <div className="card-h"><h2>Files</h2><span>{files.length}</span></div>
            <div className="list">
              {!files.length && <p className="muted">Reports, dashboards and lead sheets appear here, ready to open or download.</p>}
              {files.map((f) => (
                <div key={f.id} className="file"><span>{FILE_IC(f.mime)}</span>
                  <div><b title={f.name}>{f.name}</b><small>{kb(f.size)} · {fmtIST(f.created_at)}</small></div>
                  <a href={`/api/files/${f.id}`} target="_blank" title="Open">↗</a><a href={`/api/files/${f.id}?dl=1`} title="Download">⤓</a>
                </div>))}
            </div>
          </div>
          {!!s?.reminders.length && <div className="card"><div className="card-h"><h2>Reminders</h2></div>
            {s.reminders.slice(0, 3).map((r) => <p key={r.id} className="small">⏰ {r.text} <span className="muted">· {fmtIST(r.due_at)}</span></p>)}</div>}
        </aside>
      </section>

      <nav className="tabs">
        {([["nova", "◉", "NOVA"], ["missions", "◎", "Missions"], ["files", "⤓", "Files"]] as [View, string, string][]).map(([x, ic, l]) =>
          <button key={x} className={view === x ? "on" : ""} onClick={() => setView(x)}><span>{ic}</span>{l}{x === "files" && waiting.length > 0 && <em>{waiting.length}</em>}</button>)}
        <button onClick={() => openSheet("voice")}><span>⚙</span>Settings</button>
      </nav>

      {/* ───── Settings sheet ───── */}
      {sheet && (
        <div className="scrim" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-tabs">
              {([["voice", "Voice"], ["phone", "Phone"], ["markets", "Markets"], ["money", "Money"], ["memory", "Memory"], ["approvals", "Ideas"], ["system", "System"]] as [Sheet, string][])
                .map(([k, l]) => <button key={l} className={sheet === k ? "on" : ""} onClick={() => openSheet(k)}>{l}</button>)}
              <button className="close" onClick={() => setSheet(null)}>✕</button>
            </div>
            <div className="sheet-body">
              {sheet === "voice" && <>
                <h3>Voice</h3>
                <label className="toggle"><input type="checkbox" checked={prefs.neural} onChange={(e) => savePrefs({ ...prefs, neural: e.target.checked })} />
                  <span><b>NOVA Neural voice</b><small>Natural AI voice via your Gemini key. Falls back to the device voice automatically.</small></span></label>
                {prefs.neural && <div className="seg">{NEURAL.map((n) => <button key={n} className={prefs.neuralVoice === n ? "on" : ""} onClick={() => savePrefs({ ...prefs, neuralVoice: n })}>{n}</button>)}</div>}
                <label className="field-l">Device voice (FRIDAY-style fallback)
                  <select value={prefs.deviceVoice} onChange={(e) => savePrefs({ ...prefs, deviceVoice: e.target.value })}>
                    <option value="">Auto — best female voice ({pickVoice(v.voices)?.name ?? "…"})</option>
                    {v.voices.filter((x) => /^(en|hi)/.test(x.lang)).map((x) => <option key={x.name} value={x.name}>{x.name} · {x.lang}</option>)}
                  </select></label>
                <label className="field-l">Speed <input type="range" min={0.8} max={1.3} step={0.05} value={prefs.rate} onChange={(e) => savePrefs({ ...prefs, rate: Number(e.target.value) })} /></label>
                <div className="row"><button className="primary" onClick={() => v.speak(greeting())}>▶ Test voice</button>
                  <label className="toggle inline"><input type="checkbox" checked={direct} onChange={() => { setDirect(!direct); ls.set("nova_direct", !direct); }} /><span>Open apps instantly</span></label></div>
                <p className="muted">Wake word: say <b>“NOVA”</b> then your command, in Hinglish or English. Works in Chrome/Edge while NOVA is open. Shortcut: Alt+N.</p>
              </>}

              {sheet === "phone" && <>
                <h3>Phone Link {linked ? <span className="ok">● Connected</span> : <span className="muted">● Not connected</span>}</h3>
                <p className="muted">Lets NOVA place calls, send SMS (after your “haan”), answer or end calls, toggle the torch and sound mode, and announce incoming calls. Uses the free Android app <b>MacroDroid</b>.</p>
                {linked && <div className="row wrap">
                  <button onClick={() => phoneOp("torch_on")}>🔦 Torch on</button><button onClick={() => phoneOp("torch_off")}>Torch off</button>
                  <button onClick={() => phoneOp("vibrate")}>📳 Vibrate</button><button onClick={() => phoneOp("ring")}>🔔 Ring mode</button>
                  <button onClick={() => phoneOp("find_phone")}>📢 Find my phone</button></div>}
                <ol className="guide">
                  <li>Install <b>MacroDroid</b> from Play Store on your Android phone and open it.</li>
                  <li>Add Macro → <b>Trigger</b>: search “<b>Webhook</b>” → identifier <code>nova</code>. Copy the URL it shows (trigger.macrodroid.com/…/nova).</li>
                  <li>In the macro, add <b>local variables</b> (type String): <code>nova_action</code>, <code>nova_number</code>, <code>nova_text</code>, <code>nova_name</code>.</li>
                  <li>Add <b>Actions</b> using <b>If / Else If</b> on <code>nova_action</code>:
                    <ul><li><code>call</code> → <b>Make Call</b> to <code>{"{lv=nova_number}"}</code></li>
                      <li><code>sms</code> → <b>Send SMS</b> to <code>{"{lv=nova_number}"}</code>, text <code>{"{lv=nova_text}"}</code></li>
                      <li><code>answer</code> → <b>Answer Call</b> · <code>end_call</code> → <b>End/Reject Call</b> · <code>speaker_on</code> → <b>Speakerphone On</b></li>
                      <li><code>torch_on</code>/<code>torch_off</code> → <b>Torch</b> · <code>silent</code>/<code>vibrate</code>/<code>ring</code> → <b>Sound Mode</b></li>
                      <li><code>find_phone</code> → <b>Volume</b> max + <b>Play Sound</b></li></ul></li>
                  <li>Save the macro and allow the Phone/SMS permissions MacroDroid asks for.</li>
                  <li>Paste the webhook URL here:</li>
                </ol>
                <div className="row"><input placeholder="https://trigger.macrodroid.com/…/nova" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
                  <button className="primary" disabled={!hookUrl} onClick={async () => { const j = await run({ action: "phone_setup", url: hookUrl }); if (j) { setHookUrl(""); say(j.reply); } }}>{linked ? "Update" : "Connect"}</button></div>
                {s?.phone?.deviceKey && <>
                  <h4>Optional: incoming-call announcements</h4>
                  <p className="muted">New macro → Trigger <b>Call Incoming</b> → Action <b>HTTP Request</b> (GET) to:</p>
                  <code className="block">{`${typeof location !== "undefined" ? location.origin : ""}/api/device/event?key=${s.phone.deviceKey}&type=call&name=[call_name]&number=[call_number]`}</code>
                  <p className="muted">NOVA will say who is calling; answer with “haan, uthao” or “kaat do”.</p></>}
                <p className="muted small">Keep the webhook URL private — anyone who has it can trigger your macro. NOVA never makes payments.</p>
              </>}

              {sheet === "markets" && <>
                <h3>Markets <small>delayed · educational</small></h3>
                {!card ? <p className="muted">Say “NOVA, TCS analyse karo”. Indicators are computed in code; NOVA explains, never says buy or sell.</p> : <>
                  <div className="quote"><b>{card.symbol}</b> ₹{card.price} <span className={card.changePct >= 0 ? "up" : "down"}>{card.changePct >= 0 ? "▲" : "▼"} {card.changePct}%</span></div>
                  <div className="kv"><span>RSI 14</span><b>{card.rsi14} · {card.rsiNote}</b><span>Trend</span><b>{card.trend}</b><span>SMA 20/50</span><b>{card.sma20} / {card.sma50}</b>
                    <span>ATR 14</span><b>{card.atr14}</b><span>Volume vs 20d</span><b>{card.volRatio}×</b></div>
                  <p className="muted small">As of {fmtIST(card.asOf)} · not investment advice</p>
                  <h4>Paper trade · SL {card.paper.stop} · Target {card.paper.target}</h4>
                  {CHECKS.map((c, i) => <label key={c} className="check"><input type="checkbox" checked={!!checks[i]} onChange={(e) => { const n = [...checks]; n[i] = e.target.checked; setChecks(n); }} /> {c}</label>)}
                  <input placeholder="Why this trade?" value={thesis} onChange={(e) => setThesis(e.target.value)} />
                  <button className="primary" disabled={CHECKS.some((_, i) => !checks[i]) || !thesis.trim()} onClick={async () => { await run({ action: "paper", symbol: card.symbol, thesis }); setCard(null); }}>Log paper trade</button></>}
                <h4>Paper journal</h4>
                {s?.trades.slice(0, 8).map((t) => <p key={t.id} className="small"><b>{t.symbol}</b> {t.entry} → SL {t.stop} / T {t.target} · {t.status}</p>)}
                {!s?.trades.length && <p className="muted">No paper trades yet.</p>}
              </>}

              {sheet === "money" && <>
                <h3>Money <small>your entries only</small></h3>
                <div className="stats"><div><small>Income this month</small><b className="up">{inr(s?.metrics.monthIn ?? 0)}</b></div><div><small>Spent this month</small><b className="down">{inr(s?.metrics.monthOut ?? 0)}</b></div></div>
                {s?.ledger.slice(0, 20).map((l) => <p key={l.id} className="small"><span className={+l.amount >= 0 ? "up" : "down"}>{inr(+l.amount)}</span> {l.note} <X onClick={() => run({ action: "delete", table: "ledger", id: l.id })} /></p>)}
                {!s?.ledger.length && <p className="muted">Say “NOVA, 500 rupees kharch hua chai pe”.</p>}
              </>}

              {sheet === "memory" && <>
                <h3>Contacts <small>{s?.contacts.length ?? 0}</small></h3>
                <div className="row wrap">{s?.contacts.map((c) => <span key={c.id} className="chip">{c.name} <X onClick={() => run({ action: "delete", table: "contacts", id: c.id })} /></span>)}</div>
                {!s?.contacts.length && <p className="muted">Say “NOVA, Mummy ka number 98XXXXXXXX save karo”.</p>}
                <h3>Memory</h3>
                {s?.memory.map((x) => <p key={x.id} className="small">{x.fact} <X onClick={() => run({ action: "delete", table: "memory", id: x.id })} /></p>)}
                {!s?.memory.length && <p className="muted">Say “NOVA, yaad rakhna ki…”.</p>}
                {!!s?.addenda.length && <><h3>Learned rules</h3>{s.addenda.map((x) => <p key={x.id} className="small">{x.text} <X onClick={() => run({ action: "delete", table: "addenda", id: x.id })} /></p>)}</>}
                <h3>Recent conversation</h3>
                {s?.messages.slice(-10).map((m) => <p key={m.id} className="small"><span className="muted">{m.role === "user" ? "You" : "NOVA"}:</span> {m.content}</p>)}
              </>}

              {sheet === "approvals" && <>
                <h3>Ideas & improvements</h3>
                {!s?.proposals.some((p) => p.status === "pending") && <p className="muted">Nothing waiting. Say “business ideas batao”.</p>}
                {s?.proposals.filter((p) => p.status === "pending").map((p) => (
                  <div key={p.id} className="prop"><b>{p.title}</b><p>{p.body}</p>
                    {p.kind === "addendum" && <details><summary>Before / after test</summary><p className="small"><b>Before:</b> {p.payload.before}</p><p className="small"><b>After:</b> {p.payload.after}</p></details>}
                    <input placeholder="Reason (needed to reject)" value={reasons[p.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [p.id]: e.target.value })} />
                    <div className="row"><button className="primary" onClick={() => run({ action: "decide", id: p.id, approve: true, reason: reasons[p.id] })}>Approve</button>
                      <button onClick={() => run({ action: "decide", id: p.id, approve: false, reason: reasons[p.id] })}>Reject</button></div></div>))}
                <h4>Daily briefing</h4><p className="small">{s?.digest?.summary ?? "—"}</p>
              </>}

              {sheet === "system" && <>
                <h3>System</h3>
                <SysRow ok={brainOk} k="AI brain" v={health ? brains.map(([k, x]) => `${k}: ${x === "ok" ? `ok (${health[`${k}_model`]})` : x}`).join(" · ") || "No keys" : "Checking…"} />
                <SysRow ok k="Web research" v={engine || "…"} />
                <SysRow ok k="Missions" v="Run in the background every minute, even when NOVA is closed" />
                <SysRow ok={linked} k="Phone Link" v={linked ? "Connected via MacroDroid" : "Not connected — see Phone tab"} />
                <SysRow ok={v.supported} k="Voice" v="Chrome / Edge · screen kept awake while listening" />
                <SysRow k="Payments" v="Never — by design" />
                <div className="row"><button onClick={() => "Notification" in window && Notification.requestPermission()}>Enable notifications</button><a className="btn" href="/api/agent?export=1">Export backup</a></div>
              </>}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const SysRow = ({ ok, k, v }: { ok?: boolean; k: string; v: string }) => <div className={`sysrow ${ok ? "" : "off"}`}><i /><b>{k}</b><span>{v}</span></div>;
const X = ({ onClick }: { onClick: () => void }) => <button className="x" onClick={onClick} title="Remove">✕</button>;
