"use client";
// NOVA OS — single-screen HUD. The page never scrolls; panels scroll internally when needed.
import { useCallback, useEffect, useRef, useState } from "react";
import { useJarvisVoice } from "@/hooks/useJarvisVoice";
import { useMicLevel } from "@/hooks/useMicLevel";
import Core, { CoreMode } from "@/components/Core";
import Boot from "@/components/Boot";
import ActionCard, { launch } from "@/components/ActionCard";
import { Action, INTERNAL } from "@/lib/actions";
import type { Snapshot, Row } from "@/lib/db";
import type { Analysis } from "@/lib/market";

type View = "nova" | "tasks" | "files" | "modules";
type Module = "markets" | "approvals" | "ledger" | "mind" | "history" | "system" | null;
type Timer = { id: number; label: string; end: number };
type Attach = { name: string; text?: string; b64?: string };

const inr = (n: number) => (n < 0 ? "−₹" : "₹") + Math.round(Math.abs(n)).toLocaleString("en-IN");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fmtIST = (d: string | number) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const kb = (n: number) => (n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const CONFIRM = /^(haan|ha|haa|yes|yep|ok|okay|kar do|bhej do|bhejo|open karo|khol do|launch|go ahead|chalo)\b/i;
const ACTIVE = ["planning", "running"];
const AGENT_IC: Record<string, string> = { research: "🔎", business: "📈", hr: "🧾", data: "📊", coding: "⌨️", testing: "🧪", document: "📄", communication: "✉️", manual: "✋" };
const FILE_IC = (m: string) => (m.includes("html") ? "🖥️" : m.includes("csv") ? "📊" : m.includes("markdown") ? "📝" : "📁");
const CHIPS = ["NOVA, I want to earn money", "Find 20 potential clients for my HR/payroll work", "Build a futuristic HR dashboard",
  "Aaj ka mausam kaisa hai?", "Mummy ko WhatsApp karo ki late aaunga", "10 minute ka timer lagao", "Reliance ka setup samjhao"];
const CHECKS = ["Risk ≤ 1–2% of capital", "Stop-loss decided before entry", "Reward:risk ≥ 2:1", "I can explain WHY in one line", "Not revenge / FOMO"];

const store = { get: (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v == null ? d : v === "1"; } catch { return d; } },
  set: (k: string, v: boolean) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* ignore */ } } };
function beep(times = 2) {
  try { const ac = new AudioContext(); for (let i = 0; i < times; i++) { const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * 0.3;
    o.frequency.value = 880 + i * 220; o.connect(g); g.connect(ac.destination); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22); o.start(t); o.stop(t + 0.25); } } catch { /* no audio */ }
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
  const [input, setInput] = useState(""), [view, setView] = useState<View>("nova"), [mod, setMod] = useState<Module>(null);
  const [talk, setTalk] = useState(true), [direct, setDirect] = useState(true), [mission, setMission] = useState(false);
  const [live, setLive] = useState<{ actions: Action[]; auto: boolean; key: number } | null>(null);
  const [reply, setReply] = useState(""), [attach, setAttach] = useState<Attach | null>(null);
  const [timers, setTimers] = useState<Timer[]>([]), [clock, setClock] = useState({ t: "", d: "" });
  const [card, setCard] = useState<Analysis | null>(null), [checks, setChecks] = useState<boolean[]>([]), [thesis, setThesis] = useState("");
  const [reasons, setReasons] = useState<Record<number, string>>({}), [needInput, setNeedInput] = useState("");
  const speakRef = useRef<(t: string) => void>(() => {}), liveRef = useRef(live), prevStatus = useRef<Record<number, string>>({});
  const ticking = useRef(false), fileRef = useRef<HTMLInputElement>(null);
  liveRef.current = live;

  useEffect(() => { setTalk(store.get("nova_talk", true)); setDirect(store.get("nova_direct", true)); setMission(store.get("nova_mission", false)); }, []);
  const say = useCallback((t: string) => { setReply(t); if (talk) speakRef.current(t); }, [talk]);
  const apply = useCallback((j: { state?: Snapshot }) => { if (j?.state) setS(j.state); }, []);
  const run = useCallback(async (body: object, url = "/api/agent") => {
    setErr(""); try { const j = await call(url, body); apply(j); return j; } catch (e) { setErr((e as Error).message); }
  }, [apply]);

  // ── Send a command: confirmation → mission (task) → chat/action planner
  const send = useCallback(async (text: string) => {
    text = text.trim(); if (!text && !attach) return;
    setInput("");
    const pending = liveRef.current?.actions.find((a) => !INTERNAL.has(a.kind));
    if (pending && !liveRef.current?.auto && CONFIRM.test(text)) {
      const ok = launch(pending); setLive((l) => l && { ...l, auto: ok }); say(ok ? "Kar diya Boss." : "Browser ne roka — Launch dabao."); return;
    }
    setBusy(true); setView("nova");
    if (attach || mission) {
      const j = await run({ action: "create", goal: text || `Summarize and analyze the attached file ${attach?.name}`, file: attach ?? undefined }, "/api/tasks");
      setAttach(null); setBusy(false); if (j) say(j.reply ?? "Sure Boss, I'm on it."); return;
    }
    setS((p) => p && { ...p, messages: [...p.messages, { role: "user", content: text, id: Date.now() }] });
    const j = await run({ action: "chat", text });
    setBusy(false); if (!j) return;
    if (j.card) { setCard(j.card); setChecks([]); setThesis(""); setMod("markets"); }
    const acts: Action[] = j.actions ?? [];
    for (const a of acts) if (a.kind === "timer") setTimers((t) => [...t, { id: Date.now() + Math.random(), label: a.label || "Timer", end: Date.now() + a.seconds * 1000 }]);
    const ext = acts.find((a) => !INTERNAL.has(a.kind) && !(a.kind === "call" && !a.phone));
    const auto = !!ext && direct && launch(ext);
    setLive(acts.length ? { actions: acts, auto, key: Date.now() } : null);
    if (j.reply) say(j.reply);
  }, [run, direct, say, attach, mission]);

  const v = useJarvisVoice(send);
  speakRef.current = v.speak;
  const mic = useMicLevel(v.mode === "sleeping" || v.mode === "awake");

  // ── Boot: state, brain health, daily protocol
  useEffect(() => {
    call("/api/agent").then(async (j) => {
      apply(j);
      call("/api/agent?health=1").then((h) => { setHealth(h.health); setEngine(h.search); }).catch(() => null);
      if (j.state.digest?.day !== todayIST()) { setDaily(true); await run({ action: "daily" }); setDaily(false); }
    }).catch((e) => e.message !== "auth" && setErr(e.message));
  }, [run, apply]);

  // ── Task engine: while missions are active, keep ticking + poll state; announce completions
  const active = (s?.tasks ?? []).some((t) => ACTIVE.includes(t.status));
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const loop = async () => {
      while (!stop) {
        if (!ticking.current) { ticking.current = true; try { apply(await call("/api/tasks", { action: "tick" })); } catch { await new Promise((r) => setTimeout(r, 4000)); } ticking.current = false; }
        await new Promise((r) => setTimeout(r, 800));
      }
    };
    loop();
    const poll = setInterval(() => call("/api/agent").then(apply).catch(() => null), 4000);
    return () => { stop = true; clearInterval(poll); };
  }, [active, apply]);
  useEffect(() => {
    for (const t of s?.tasks ?? []) {
      const before = prevStatus.current[t.id];
      if (before && before !== t.status) {
        if (t.status === "completed") { beep(3); notify("✅ NOVA · " + t.title, t.summary ?? "Ready"); say(`Boss, ${t.title} ready hai. ${t.summary ?? ""}`); setView("files"); }
        if (t.status === "waiting_user") { beep(2); notify("✋ NOVA needs you", t.needs ?? ""); say(`Boss, mujhe aapse ek manual step chahiye: ${t.needs ?? ""}. Uske baad main khud continue karungi.`); }
        if (t.status === "failed") say(`Boss, ${t.title} mein problem aayi. Retry kar sakte hain.`);
      }
      prevStatus.current[t.id] = t.status;
    }
  }, [s?.tasks, say]);

  // ── Clock, timers, reminders
  useEffect(() => {
    const iv = setInterval(() => {
      const d = new Date();
      setClock({ t: d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }),
        d: d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }) });
      setTimers((ts) => { const due = ts.filter((t) => t.end <= Date.now());
        for (const t of due) { beep(3); notify("⏱️ NOVA timer", t.label); speakRef.current(`Boss, ${t.label} ka time ho gaya.`); }
        return due.length ? ts.filter((t) => t.end > Date.now()) : ts; });
    }, 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    const iv = setInterval(() => { for (const r of s?.reminders ?? []) if (Date.parse(r.due_at) <= Date.now()) {
      beep(3); notify("⏰ NOVA reminder", r.text); speakRef.current(`Reminder, Boss: ${r.text}`); run({ action: "reminder_done", id: r.id }); } }, 15000);
    return () => clearInterval(iv);
  }, [s?.reminders, run]);
  useEffect(() => {
    if (v.mode === "off" || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock: { request: (t: string) => Promise<typeof lock> } }).wakeLock.request("screen").then((l) => (lock = l)).catch(() => null);
    return () => { lock?.release().catch(() => null); };
  }, [v.mode]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.altKey && e.key.toLowerCase() === "n") v.trigger(); if (e.key === "Escape") setMod(null); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [v]);

  async function pickFile(f?: File) {
    if (!f) return;
    if (/\.pdf$/i.test(f.name)) { const buf = new Uint8Array(await f.arrayBuffer()); let bin = ""; buf.forEach((b) => (bin += String.fromCharCode(b))); setAttach({ name: f.name, b64: btoa(bin) }); }
    else setAttach({ name: f.name, text: (await f.text()).slice(0, 60000) });
  }

  const tasks = s?.tasks ?? [], files = s?.files ?? [];
  const current = tasks.find((t) => t.status === "waiting_user") ?? tasks.find((t) => ACTIVE.includes(t.status)) ?? tasks[0];
  const curSteps = (s?.steps ?? []).filter((x) => x.task_id === current?.id);
  const pct = curSteps.length ? Math.round((curSteps.filter((x) => x.status === "done").length / curSteps.length) * 100) : 0;
  const waiting = tasks.filter((t) => t.status === "waiting_user");
  const lastDone = tasks.find((t) => t.status === "completed");
  const mainFile = (t?: Row) => files.find((f) => f.task_id === t?.id && f.mime === "text/html") ?? files.find((f) => f.task_id === t?.id);
  const mode: CoreMode = busy || daily ? "thinking" : active && v.mode === "off" ? "thinking" : v.mode;
  const status = busy ? "PROCESSING" : active ? String(current?.phase ?? "EXECUTING").split(" · ")[0].toUpperCase()
    : { off: "STANDBY", sleeping: 'SAY "NOVA"', awake: "LISTENING", speaking: "SPEAKING", thinking: "PROCESSING" }[v.mode];
  const brains = Object.entries(health ?? {}).filter(([k]) => !k.endsWith("_model"));
  const brainBad = !!health && brains.every(([, x]) => x !== "ok");
  const lastAssistant = [...(s?.messages ?? [])].reverse().find((m) => m.role === "assistant")?.content;
  const vis = (x: View) => (view === x ? "" : "m-hide");

  return (
    <main className="os">
      <Boot />
      <div className="scan" />
      {/* ───── Header ───── */}
      <header className="hdr">
        <div className="brand"><span className="hex">⬡</span><b>NOVA</b><em>personal AI employee</em></div>
        <div className="clock"><b>{clock.t}</b><span>{clock.d}<br />IST</span></div>
        <div className="brains">
          {health ? brains.map(([k, st]) => <span key={k} className={`chip ${st === "ok" ? "live" : "bad"}`} title={st === "ok" ? `model: ${health[`${k}_model`] ?? "?"}` : st}>{k.toUpperCase()}</span>)
            : <span className="chip">LINKING…</span>}
          {engine && <span className="chip" title="Web search engine">🔎 {engine}</span>}
        </div>
        <div className="ctl">
          <button className={`tg ${mission ? "on amber" : ""}`} onClick={() => { setMission(!mission); store.set("nova_mission", !mission); }} title="Mission mode: every command becomes an autonomous task">🎯 Mission</button>
          <button className={`tg ${direct ? "on" : ""}`} onClick={() => { setDirect(!direct); store.set("nova_direct", !direct); }} title="Direct mode: open apps instantly">⚡</button>
          <button className={`tg ${talk ? "on" : ""}`} onClick={() => { setTalk(!talk); store.set("nova_talk", !talk); }} title="Voice replies">{talk ? "🔊" : "🔇"}</button>
          <button className="tg" onClick={() => "Notification" in window && Notification.requestPermission()} title="Notifications">🔔</button>
          <button className="tg" onClick={() => setMod("system")} title="Systems">⚙</button>
        </div>
      </header>
      {(err || brainBad) && <div className="alert" onClick={() => setErr("")}>
        ⚠ {err || (brains.length ? `Brain offline — ${brains.map(([k, x]) => `${k}: ${x}`).join(" · ")}. Fix the key in Vercel → Settings → Environment Variables, then Redeploy.` : "No AI key found. Add NVIDIA_API_KEY (or GROQ_API_KEY) in Vercel, then Redeploy.")}</div>}

      <section className="deck">
        {/* ───── Left: missions ───── */}
        <aside className={`rail left ${vis("tasks")}`}>
          <Panel title="Mission queue" note={`${tasks.filter((t) => ACTIVE.includes(t.status)).length} active`} grow>
            {!tasks.length && <p className="hint">Give NOVA a goal — “Find clients for my payroll business”. She plans, researches, builds and delivers.</p>}
            {tasks.map((t) => { const st = (s?.steps ?? []).filter((x) => x.task_id === t.id), done = st.filter((x) => x.status === "done").length;
              return <button key={t.id} className={`mission ${t.status} ${t.id === current?.id ? "sel" : ""}`} onClick={() => setView("nova")}>
                <i /><div><b>{t.title}</b><small>{t.phase}{st.length ? ` · ${done}/${st.length}` : ""}</small>
                  {st.length > 0 && <span className="bar"><span style={{ width: `${(done / st.length) * 100}%` }} /></span>}</div></button>; })}
          </Panel>
          <Panel title="Today" note={clock.d}>
            <div className="mini">
              <Stat k="Tasks done" v={tasks.filter((t) => t.status === "completed").length} />
              <Stat k="Files" v={files.length} />
              <Stat k="Needs you" v={waiting.length} hot={!!waiting.length} />
            </div>
            {timers.map((t) => { const l = Math.max(0, Math.round((t.end - Date.now()) / 1000));
              return <p key={t.id} className="line">⏱ <b className="mono">{Math.floor(l / 60)}:{String(l % 60).padStart(2, "0")}</b> {t.label}</p>; })}
            {s?.reminders.slice(0, 2).map((r) => <p key={r.id} className="line">⏰ {r.text} <span className="dim">{fmtIST(r.due_at)}</span></p>)}
          </Panel>
          <nav className="dock">
            {([["markets", "₹", "Markets"], ["approvals", "✓", "Approvals"], ["ledger", "◈", "Ledger"], ["mind", "✦", "Mind"], ["history", "☰", "History"], ["system", "⚙", "System"]] as [Module, string, string][])
              .map(([m, ic, l]) => <button key={l} onClick={() => setMod(m)}><span>{ic}</span>{l}{m === "approvals" && !!s?.metrics.pending && <em>{s.metrics.pending}</em>}</button>)}
          </nav>
        </aside>

        {/* ───── Center: core + current + input ───── */}
        <div className={`center ${vis("nova")}`}>
          <div className="stage">
            <div className="halo" />
            <Core mode={mode} level={mic} onClick={v.trigger} size={250} />
            <div className={`status ${mode}`}>{status}</div>
            <p className="interim">{v.interim || (v.mode === "awake" ? "Bolo Boss…" : " ")}</p>
          </div>

          {current && (
            <div className={`now ${current.status}`}>
              <div className="now-h"><span className="tag">{current.status === "completed" ? "LAST MISSION" : "CURRENT MISSION"}</span>
                <b>{current.title}</b><span className="pct mono">{pct}%</span></div>
              <div className="steps">{curSteps.map((x) => <span key={x.id} className={`st ${x.status}`} title={`${x.title} · ${x.status}`}>{AGENT_IC[x.agent] ?? "•"}<small>{x.title}</small></span>)}</div>
              <div className="now-f"><span>{current.phase}</span>
                {current.status === "failed" && <button onClick={() => run({ action: "retry", id: current.id }, "/api/tasks")}>↻ Retry</button>}
                {ACTIVE.includes(current.status) && <button onClick={() => run({ action: "cancel", id: current.id }, "/api/tasks")}>Stop</button>}</div>
            </div>
          )}

          <div className="says">
            <span className="tag">NOVA</span>
            <p>{busy ? <span className="dots"><i /><i /><i /></span> : reply || lastAssistant || "Online, Boss. Give me a goal or a quick command."}</p>
            {live && <div className="acts">{live.actions.map((a, k) => <ActionCard key={live.key + "-" + k} a={a}
              auto={live.auto && a === live.actions.find((y) => !INTERNAL.has(y.kind))} onContact={(name, phone) => run({ action: "contact", name, phone })} />)}</div>}
          </div>

          <div className="cmd">
            <div className="chips">{CHIPS.map((c) => <button key={c} onClick={() => send(c)}>{c}</button>)}</div>
            <form className="bar-in" onSubmit={(e) => { e.preventDefault(); send(input); }}>
              <button type="button" className={`mic ${v.mode !== "off" ? "on" : ""}`} onClick={v.mode === "off" ? v.start : v.stop}
                title={v.supported ? "Arm wake word" : "Voice needs Chrome/Edge"} disabled={!v.supported}>{v.mode === "off" ? "🎙" : "◉"}</button>
              <button type="button" className="clip" onClick={() => fileRef.current?.click()} title="Attach PDF / TXT / CSV">📎</button>
              <input ref={fileRef} type="file" hidden accept=".pdf,.txt,.md,.csv,.json" onChange={(e) => pickFile(e.target.files?.[0])} />
              {attach && <span className="att">{attach.name} <button type="button" onClick={() => setAttach(null)}>✕</button></span>}
              <input className="field" value={input} onChange={(e) => setInput(e.target.value)}
                placeholder={mission ? "🎯 Mission: describe a goal — NOVA will plan & execute" : "Command NOVA — Hinglish ya English…"} />
              <button className="send" disabled={busy || (!input.trim() && !attach)}>➤</button>
            </form>
          </div>
        </div>

        {/* ───── Right: needs you + deliverables ───── */}
        <aside className={`rail right ${vis("files")}`}>
          {waiting.map((t) => (
            <div key={t.id} className="need">
              <span className="tag">✋ NEEDS YOU · {t.title}</span>
              <p>{t.needs}</p>
              <input placeholder="Add a note/result (optional)" value={needInput} onChange={(e) => setNeedInput(e.target.value)} />
              <button className="go" onClick={() => { run({ action: "resume", id: t.id, input: needInput }, "/api/tasks"); setNeedInput(""); say("Thanks Boss, continuing."); }}>✓ Done — continue</button>
            </div>
          ))}
          {lastDone && mainFile(lastDone) && (
            <div className="ready">
              <span className="tag">✅ READY</span>
              <b>{lastDone.title}</b>
              <p>{lastDone.summary}</p>
              <div className="row"><a className="btn go" href={`/api/files/${mainFile(lastDone)!.id}`} target="_blank">Open ↗</a>
                <a className="btn" href={`/api/files/${mainFile(lastDone)!.id}?dl=1`}>⤓ Download</a></div>
            </div>
          )}
          <Panel title="Deliverables" note={`${files.length} files`} grow>
            {!files.length && <p className="hint">Reports, dashboards, lead sheets and websites NOVA builds appear here — open or download in one tap.</p>}
            {files.map((f) => (
              <div key={f.id} className="file">
                <span className="fic">{FILE_IC(f.mime)}</span>
                <div><b title={f.name}>{f.name}</b><small>{kb(f.size)} · {fmtIST(f.created_at)}</small></div>
                <a href={`/api/files/${f.id}`} target="_blank" title="Open">↗</a>
                <a href={`/api/files/${f.id}?dl=1`} title="Download">⤓</a>
              </div>
            ))}
          </Panel>
        </aside>
      </section>

      {/* ───── Mobile tab bar ───── */}
      <nav className="tabs">
        {([["nova", "◉", "NOVA"], ["tasks", "◎", "Missions"], ["files", "⤓", "Files"], ["modules", "▦", "Modules"]] as [View, string, string][])
          .map(([x, ic, l]) => <button key={x} className={view === x ? "on" : ""} onClick={() => (x === "modules" ? setMod("system") : setView(x))}>
            <span>{ic}</span>{l}{x === "files" && waiting.length > 0 && <em>{waiting.length}</em>}</button>)}
      </nav>

      {/* ───── Module drawer ───── */}
      {mod && (
        <div className="scrim" onClick={() => setMod(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="dtabs">{(["markets", "approvals", "ledger", "mind", "history", "system"] as Module[]).map((m) =>
              <button key={m!} className={mod === m ? "on" : ""} onClick={() => setMod(m)}>{m}</button>)}<button className="x" onClick={() => setMod(null)}>✕</button></div>
            <div className="dbody">
              {mod === "markets" && <>
                <h3>Market lens <small>delayed · educational</small></h3>
                {!card ? <p className="hint">“NOVA, TCS analyse karo”. Indicators are computed in code; NOVA explains, never says buy/sell.</p> : <>
                  <div className="quote"><b>{card.symbol}</b> ₹{card.price} <span className={card.changePct >= 0 ? "up" : "down"}>{card.changePct >= 0 ? "▲" : "▼"} {card.changePct}%</span></div>
                  <div className="gauge"><i style={{ left: `${Math.min(100, Math.max(0, card.rsi14))}%` }} /><span>30</span><span>RSI {card.rsi14}</span><span>70</span></div>
                  <div className="kv"><span>Trend</span><b>{card.trend}</b><span>SMA 20/50</span><b>{card.sma20} / {card.sma50}</b><span>ATR 14</span><b>{card.atr14}</b>
                    <span>Vol vs 20d</span><b>{card.volRatio}×</b><span>6m range</span><b>{card.low6m} – {card.high6m}</b></div>
                  <p className="hint">As of {fmtIST(card.asOf)} IST · not investment advice</p>
                  <h4>Paper template · SL {card.paper.stop} · T {card.paper.target}</h4>
                  {CHECKS.map((c, i) => <label key={c} className="check"><input type="checkbox" checked={!!checks[i]} onChange={(e) => { const n = [...checks]; n[i] = e.target.checked; setChecks(n); }} /> {c}</label>)}
                  <input placeholder="Why this trade?" value={thesis} onChange={(e) => setThesis(e.target.value)} />
                  <button disabled={CHECKS.some((_, i) => !checks[i]) || !thesis.trim()} onClick={async () => { await run({ action: "paper", symbol: card.symbol, thesis }); setCard(null); }}>Log paper trade</button></>}
                <h3>Paper journal</h3>
                {s?.trades.slice(0, 8).map((t) => <p key={t.id} className="line"><b>{t.symbol}</b> {t.entry} → SL {t.stop} / T {t.target} <span className={`pill ${t.status}`}>{t.status}</span></p>)}
                {!s?.trades.length && <p className="hint">No paper trades yet.</p>}
              </>}
              {mod === "approvals" && <>
                <h3>Approval queue <small>ideas & self-improvements</small></h3>
                {!s?.proposals.some((p) => p.status === "pending") && <p className="hint">Nothing pending.</p>}
                {s?.proposals.filter((p) => p.status === "pending").map((p) => (
                  <div key={p.id} className={`prop ${p.kind}`}><span className="tag">{p.kind === "addendum" ? "self-improvement" : p.kind}</span><b>{p.title}</b><p>{p.body}</p>
                    {p.kind === "addendum" && <details><summary>A/B test on: “{p.payload.test_question}”</summary><div className="diff"><div><em>Before</em>{p.payload.before}</div><div><em>After</em>{p.payload.after}</div></div></details>}
                    <input placeholder="Reason (required to reject)" value={reasons[p.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [p.id]: e.target.value })} />
                    <div className="row"><button className="ok" onClick={() => run({ action: "decide", id: p.id, approve: true, reason: reasons[p.id] })}>✓ Approve</button>
                      <button className="no" onClick={() => run({ action: "decide", id: p.id, approve: false, reason: reasons[p.id] })}>✕ Reject</button></div></div>))}
                <h3>Daily protocol <small>{s?.digest?.day}</small></h3><p className="line">{s?.digest?.summary ?? "—"}</p>
                <button disabled={daily} onClick={async () => { setDaily(true); await run({ action: "daily", force: true }); setDaily(false); }}>↻ Run now</button>
              </>}
              {mod === "ledger" && <>
                <h3>Ledger <small>your entries only</small></h3>
                <div className="mini"><Stat k="Income · month" v={inr(s?.metrics.monthIn ?? 0)} /><Stat k="Spend · month" v={inr(s?.metrics.monthOut ?? 0)} /></div>
                {s?.ledger.slice(0, 20).map((l) => <p key={l.id} className="line"><span className={+l.amount >= 0 ? "up" : "down"}>{inr(+l.amount)}</span> {l.note} <X onClick={() => run({ action: "delete", table: "ledger", id: l.id })} /></p>)}
                {!s?.ledger.length && <p className="hint">“NOVA, 500 rupees kharch hua chai pe”</p>}
              </>}
              {mod === "mind" && <>
                <h3>Contacts <small>{s?.contacts.length} saved</small></h3>
                <div className="row wrap">{s?.contacts.map((c) => <span key={c.id} className="chip">{c.name} <X onClick={() => run({ action: "delete", table: "contacts", id: c.id })} /></span>)}</div>
                {!s?.contacts.length && <p className="hint">“NOVA, Mummy ka number 98XXXXXXXX save karo”</p>}
                <h3>Memory</h3>
                {s?.memory.map((x) => <p key={x.id} className="line">🧠 {x.fact} <X onClick={() => run({ action: "delete", table: "memory", id: x.id })} /></p>)}
                <h3>Learned rules</h3>
                {s?.addenda.map((x) => <p key={x.id} className="line">⚙ {x.text} <X onClick={() => run({ action: "delete", table: "addenda", id: x.id })} /></p>)}
                {!!s?.watchlist.length && <><h3>Watchlist</h3><div className="row wrap">{s.watchlist.map((w) => <span key={w.symbol} className="chip">{w.symbol} <X onClick={() => run({ action: "delete", table: "watchlist", id: w.symbol })} /></span>)}</div></>}
              </>}
              {mod === "history" && <>
                <h3>Conversation</h3>
                {s?.messages.map((m) => <div key={m.id} className={`msg ${m.role}`}>{m.content}</div>)}
                <h3>Action log</h3>
                {s?.actions.map((a) => <p key={a.id} className="line"><span className="dim">{fmtIST(a.at)}</span> {a.kind}</p>)}
              </>}
              {mod === "system" && <>
                <h3>Systems</h3>
                <Sys ok={!brainBad && !!health} label="Brain" note={health ? brains.map(([k, x]) => `${k}: ${x === "ok" ? `ok (${health[`${k}_model`]})` : x}`).join(" · ") || "no keys" : "checking…"} />
                <Sys ok label="Task engine" note="Orchestrator → Research · Business · HR · Data · Coding · Testing · Document · Communication agents" />
                <Sys ok label="Background work" note="Continues every minute via Supabase scheduler, even with NOVA closed" />
                <Sys ok label="Web research" note={`${engine || "…"} · add a free TAVILY_API_KEY in Vercel for full web search`} />
                <Sys ok={v.supported} label="Voice & wake word" note="Chrome/Edge · screen kept awake while armed" />
                <Sys ok label="Phone actions" note="WhatsApp · call · SMS · email · maps · YouTube · apps · calendar · timers · reminders" />
                <Sys label="Payments / banking / sending as you" note="Never — NOVA drafts, you send" />
                <p className="hint">Export everything: <a href="/api/agent?export=1">⤓ backup.json</a></p>
              </>}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

const Panel = ({ title, note, grow, children }: { title: string; note?: string; grow?: boolean; children: React.ReactNode }) => (
  <div className={`panel ${grow ? "grow" : ""}`}><h2>{title}{note && <small>{note}</small>}</h2><div className="pbody">{children}</div></div>
);
const Stat = ({ k, v, hot }: { k: string; v: React.ReactNode; hot?: boolean }) => <div className={`stat ${hot ? "hot" : ""}`}><b className="mono">{v}</b><span>{k}</span></div>;
const Sys = ({ ok, label, note }: { ok?: boolean; label: string; note: string }) => <div className={`sys ${ok ? "" : "off"}`}><i />{label}<small>{note}</small></div>;
const X = ({ onClick }: { onClick: () => void }) => <button className="x" onClick={onClick} title="Remove">✕</button>;
