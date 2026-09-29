"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useJarvisVoice } from "@/hooks/useJarvisVoice";
import { useMicLevel } from "@/hooks/useMicLevel";
import Core, { CoreMode } from "@/components/Core";
import Boot from "@/components/Boot";
import ActionCard, { launch } from "@/components/ActionCard";
import { Action, INTERNAL } from "@/lib/actions";
import type { Snapshot, Row } from "@/lib/db";
import type { Analysis } from "@/lib/market";

type Tab = "core" | "tasks" | "markets" | "mind" | "system";
type Timer = { id: number; label: string; end: number };
const inr = (n: number) => (n < 0 ? "−₹" : "₹") + Math.round(Math.abs(n)).toLocaleString("en-IN");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const fmtIST = (d: string | number) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const CONFIRM = /^(haan|ha|haa|yes|yep|ok|okay|kar do|bhej do|bhejo|open karo|khol do|launch|go ahead|chalo)\b/i;
const CHECKS = ["Risk ≤ 1–2% of capital", "Stop-loss decided before entry", "Reward:risk ≥ 2:1", "I can explain WHY in one line", "Not revenge / FOMO"];
const CHIPS = ["Aaj ka mausam kaisa hai?", "5 minute ka timer lagao", "Mummy ko WhatsApp karo ki main late aaunga", "YouTube pe lo-fi music chalao",
  "India Gate ka rasta dikhao", "Kal subah 9 baje meeting yaad dilana", "Reliance ka setup samjhao", "Business ideas batao"];

const store = { get: (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v == null ? d : v === "1"; } catch { return d; } },
  set: (k: string, v: boolean) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* ignore */ } } };

function beep(times = 3) {
  try {
    const ac = new AudioContext();
    for (let i = 0; i < times; i++) {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * 0.35;
      o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.start(t); o.stop(t + 0.3);
    }
  } catch { /* no audio */ }
}
function notify(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, icon: "/icon.svg" });
}

async function api(body?: object) {
  const r = await fetch("/api/agent", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (r.status === 401) { location.href = "/login"; throw new Error("auth"); }
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Request failed");
  return j;
}

export default function Home() {
  const [s, setS] = useState<Snapshot | null>(null), [prov, setProv] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [daily, setDaily] = useState(false);
  const [input, setInput] = useState(""), [tab, setTab] = useState<Tab>("core"), [clock, setClock] = useState("");
  const [talk, setTalk] = useState(true), [direct, setDirect] = useState(true);
  const [live, setLive] = useState<{ actions: Action[]; auto: boolean; key: number } | null>(null);
  const [timers, setTimers] = useState<Timer[]>([]), [, force] = useState(0);
  const [card, setCard] = useState<Analysis | null>(null), [checks, setChecks] = useState<boolean[]>([]), [thesis, setThesis] = useState("");
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const feedRef = useRef<HTMLDivElement>(null), speakRef = useRef<(t: string) => void>(() => {}), liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => { setTalk(store.get("nova_talk", true)); setDirect(store.get("nova_direct", true)); }, []);

  const run = useCallback(async (body: object) => {
    setErr("");
    try { const j = await api(body); setS(j.state); return j; } catch (e) { setErr((e as Error).message); }
  }, []);

  const say = useCallback((t: string) => { if (talk) speakRef.current(t); }, [talk]);

  const send = useCallback(async (text: string) => {
    text = text.trim(); if (!text) return;
    setInput("");
    // Voice/typed confirmation of a pending launch: "haan", "bhej do", "open karo"
    const pending = liveRef.current?.actions.find((a) => !INTERNAL.has(a.kind));
    if (pending && !liveRef.current?.auto && CONFIRM.test(text)) {
      const ok = launch(pending); setLive((l) => l && { ...l, auto: ok });
      say(ok ? "Kar diya Boss." : "Browser ne roka — Launch button dabao."); return;
    }
    setBusy(true); setTab("core");
    setS((p) => p && { ...p, messages: [...p.messages, { role: "user", content: text, id: Date.now() }] });
    const j = await run({ action: "chat", text });
    setBusy(false);
    if (!j) return;
    if (j.card) { setCard(j.card); setChecks([]); setThesis(""); }
    const acts: Action[] = j.actions ?? [];
    for (const a of acts) if (a.kind === "timer") setTimers((t) => [...t, { id: Date.now() + Math.random(), label: a.label || "Timer", end: Date.now() + a.seconds * 1000 }]);
    const ext = acts.find((a) => !INTERNAL.has(a.kind) && !(a.kind === "call" && !a.phone));
    const auto = !!ext && direct && launch(ext);
    setLive(acts.length ? { actions: acts, auto, key: Date.now() } : null);
    if (j.reply) say(j.reply);
  }, [run, direct, say]);

  const v = useJarvisVoice(send);
  speakRef.current = v.speak;
  const mic = useMicLevel(v.mode === "sleeping" || v.mode === "awake");

  // Boot: state + providers, daily protocol once per IST day
  useEffect(() => {
    api().then(async (j) => {
      setS(j.state); setProv(j.providers ?? []);
      if (j.state.digest?.day !== todayIST()) {
        setDaily(true); const d = await run({ action: "daily" }); setDaily(false);
        if (d?.state.metrics.pending) notify("NOVA · Daily briefing", d.summary);
      }
    }).catch((e) => e.message !== "auth" && setErr(e.message));
  }, [run]);

  // Clock, timers, reminders (run while NOVA is open)
  useEffect(() => {
    const iv = setInterval(() => {
      setClock(new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setTimers((ts) => {
        const due = ts.filter((t) => t.end <= Date.now());
        for (const t of due) { beep(); notify("⏱️ NOVA timer", t.label); speakRef.current(`Boss, ${t.label} ka time ho gaya.`); }
        return due.length ? ts.filter((t) => t.end > Date.now()) : ts;
      });
      force((x) => x + 1);
    }, 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    const iv = setInterval(() => {
      for (const r of s?.reminders ?? []) if (Date.parse(r.due_at) <= Date.now()) {
        beep(); notify("⏰ NOVA reminder", r.text); speakRef.current(`Reminder, Boss: ${r.text}`);
        run({ action: "reminder_done", id: r.id });
      }
    }, 15000);
    return () => clearInterval(iv);
  }, [s?.reminders, run]);

  // Keep the screen awake while the wake word is armed
  useEffect(() => {
    if (v.mode === "off" || !("wakeLock" in navigator)) return;
    let lock: { release: () => Promise<void> } | null = null;
    (navigator as unknown as { wakeLock: { request: (t: string) => Promise<typeof lock> } }).wakeLock.request("screen").then((l) => (lock = l)).catch(() => null);
    return () => { lock?.release().catch(() => null); };
  }, [v.mode]);

  useEffect(() => { feedRef.current?.scrollTo({ top: 1e6, behavior: "smooth" }); }, [s?.messages.length, live, busy]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.altKey && e.key.toLowerCase() === "n") v.trigger(); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [v]);

  const m = s?.metrics;
  const pending = s?.proposals.filter((p) => p.status === "pending") ?? [];
  const decided = s?.proposals.filter((p) => p.status !== "pending").slice(0, 5) ?? [];
  const mode: CoreMode = busy || daily ? "thinking" : v.mode;
  const vis = (t: Tab) => (tab === t ? "" : "hide-m");
  const status = { off: "STANDBY", sleeping: 'SAY "NOVA"', awake: "LISTENING", speaking: "SPEAKING", thinking: "PROCESSING" }[mode];
  const lastAsst = s?.messages.map((x) => x.role).lastIndexOf("assistant") ?? -1;

  return (
    <main className="shell">
      <Boot />
      <div className="scan" />
      <header className="top">
        <div className="brand"><span className="hex">⬡</span> NOVA <em>v2 · personal intelligence</em></div>
        <div className="top-mid">
          <span className="clock">{clock} IST</span>
          {prov.length ? prov.map((p, i) => <span key={p} className={`chip ${i ? "" : "live"}`}>{p.toUpperCase()}</span>)
            : <span className="chip warn">NO BRAIN KEY</span>}
        </div>
        <div className="row">
          <button className={`tg ${direct ? "on" : ""}`} onClick={() => { setDirect(!direct); store.set("nova_direct", !direct); }} title="Direct mode: NOVA opens apps immediately">⚡ Direct {direct ? "ON" : "OFF"}</button>
          <button className={`tg ${talk ? "on" : ""}`} onClick={() => { setTalk(!talk); store.set("nova_talk", !talk); }}>{talk ? "🔊" : "🔇"}</button>
          <button className="tg" onClick={() => "Notification" in window && Notification.requestPermission()} title="Enable notifications">🔔</button>
          <a className="tg" href="/api/agent?export=1" title="Backup">⤓</a>
        </div>
      </header>
      {err && <div className="errbar" onClick={() => setErr("")}>⚠ {err} ✕</div>}

      <section className="grid">
        {/* LEFT — mission control */}
        <div className="col">
          <Panel title="Mission control" note="live" cls={vis("tasks")}>
            <div className="metrics">
              <Tile k="Tasks today" v={m?.tasksToday ?? "–"} />
              <Tile k="Approvals" v={m?.pending ?? "–"} hot={!!m?.pending} />
              <Tile k="Reminders" v={s?.reminders.length ?? "–"} />
              <Tile k="Paper hit-rate" v={m?.hitRate == null ? "—" : `${m.hitRate}%`} />
              <Tile k="Income · month" v={m ? inr(m.monthIn) : "–"} />
              <Tile k="Spend · month" v={m ? inr(m.monthOut) : "–"} />
            </div>
          </Panel>
          <Panel title="Timers & reminders" note={timers.length + (s?.reminders.length ?? 0) ? "active" : "idle"} cls={vis("tasks")}>
            {timers.map((t) => { const left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
              return <div key={t.id} className="timer"><b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</b> {t.label}
                <X onClick={() => setTimers((ts) => ts.filter((x) => x.id !== t.id))} /></div>; })}
            {s?.reminders.map((r) => <p key={r.id} className="small">⏰ {r.text} <span className="dim">· {fmtIST(r.due_at)}</span>
              <X onClick={() => run({ action: "delete", table: "reminders", id: r.id })} /></p>)}
            {!timers.length && !s?.reminders.length && <p className="dim small">“NOVA, 10 minute ka timer lagao” · “kal 8 baje gym yaad dilana”</p>}
            <p className="dim tiny">Fires while NOVA is open (keep the tab/app open).</p>
          </Panel>
          <Panel title="Daily protocol" note={daily ? "running…" : s?.digest?.day ?? "—"} cls={vis("tasks")}>
            <p className="dim small">{s?.digest?.summary ?? "First briefing runs when you open NOVA today."}</p>
            <button disabled={daily} onClick={async () => { setDaily(true); await run({ action: "daily", force: true }); setDaily(false); }}>↻ Run now</button>
          </Panel>
          <Panel title="Approval queue" note={`${pending.length} waiting`} cls={`grow ${vis("tasks")}`}>
            {!pending.length && <p className="dim small">Nothing pending. Say “business ideas batao”.</p>}
            {pending.map((p) => (
              <div key={p.id} className={`prop ${p.kind}`}>
                <div className="tag">{p.kind === "addendum" ? "self-improvement" : p.kind}</div>
                <b>{p.title}</b><p>{p.body}</p>
                {p.kind === "addendum" && <Diff p={p} />}
                <input placeholder="Reason (required to reject)" value={reasons[p.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [p.id]: e.target.value })} />
                <div className="row">
                  <button className="ok" onClick={() => run({ action: "decide", id: p.id, approve: true, reason: reasons[p.id] })}>✓ Approve</button>
                  <button className="no" onClick={() => run({ action: "decide", id: p.id, approve: false, reason: reasons[p.id] })}>✕ Reject</button>
                </div>
              </div>
            ))}
            {!!decided.length && <details><summary>Recent decisions</summary>
              {decided.map((p) => <p key={p.id} className="dim small">{p.status === "approved" ? "✓" : "✕"} {p.title}</p>)}</details>}
          </Panel>
          <Panel title="Action log" note="last 30" cls={vis("tasks")}>
            {!s?.actions.length && <p className="dim small">No actions yet.</p>}
            {s?.actions.slice(0, 8).map((a) => <p key={a.id} className="small log"><span>{fmtIST(a.at)}</span> {a.kind}</p>)}
          </Panel>
        </div>

        {/* CENTER — core + conversation */}
        <div className={`col center ${vis("core")}`}>
          <div className="core-wrap">
            <Core mode={mode} level={mic} onClick={v.trigger} size={260} />
            <div className={`status ${mode}`}>{status}</div>
            <p className="interim">{v.interim || (mode === "awake" ? "Bolo Boss…" : " ")}</p>
            <div className="row center-row">
              {v.supported
                ? <button className={`arm ${v.mode !== "off" ? "on" : ""}`} onClick={v.mode === "off" ? v.start : v.stop}>{v.mode === "off" ? "🎙 Arm wake word" : "⏹ Disarm"}</button>
                : <span className="chip warn">Voice needs Chrome/Edge</span>}
              <button className="arm" onClick={v.trigger}>Tap to talk</button>
            </div>
          </div>
          <div className="panel feed" ref={feedRef}>
            {!s?.messages.length && <div className="hello"><b>NOVA online.</b> Try: “NOVA, Mummy ko WhatsApp karo ki late hoga” or tap a chip below.</div>}
            {s?.messages.map((x, i) => (
              <div key={x.id} className={`msg ${x.role}`}>
                {i === lastAsst && x.role === "assistant" ? <Typer text={x.content} /> : x.content}
                {i === lastAsst && live && live.actions.map((a, k) =>
                  <ActionCard key={live.key + "-" + k} a={a} auto={live.auto && a === live.actions.find((y) => !INTERNAL.has(y.kind))}
                    onContact={(name, phone) => run({ action: "contact", name, phone })} />)}
              </div>
            ))}
            {busy && <div className="msg assistant thinking"><i /><i /><i /></div>}
          </div>
          <div className="chips">{CHIPS.map((c) => <button key={c} onClick={() => send(c)}>{c}</button>)}</div>
          <form className="ask" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Command NOVA — Hinglish ya English…" />
            <button className="go" disabled={busy || !input.trim()}>➤</button>
          </form>
        </div>

        {/* RIGHT — markets, mind, systems */}
        <div className="col">
          <Panel title="Market lens" note="delayed · educational" cls={vis("markets")}>
            {!card ? <p className="dim small">“NOVA, TCS analyse karo”. Indicators computed in code; NOVA explains, never says buy/sell.</p> : (
              <>
                <div className="quote"><b>{card.symbol}</b> ₹{card.price}
                  <span className={card.changePct >= 0 ? "up" : "down"}> {card.changePct >= 0 ? "▲" : "▼"} {card.changePct}%</span></div>
                <div className="gauge"><i style={{ left: `${Math.min(100, Math.max(0, card.rsi14))}%` }} /><span>30</span><span>RSI {card.rsi14}</span><span>70</span></div>
                <div className="kv">
                  <span>Trend</span><b>{card.trend}</b><span>SMA 20/50</span><b>{card.sma20} / {card.sma50}</b>
                  <span>ATR 14</span><b>{card.atr14}</b><span>Vol vs 20d</span><b>{card.volRatio}×</b><span>6m range</span><b>{card.low6m} – {card.high6m}</b>
                </div>
                <p className="dim tiny">As of {fmtIST(card.asOf)} IST · not investment advice</p>
                <h3>Paper template · SL {card.paper.stop} · T {card.paper.target}</h3>
                {CHECKS.map((c, i) => <label key={c} className="check"><input type="checkbox" checked={!!checks[i]}
                  onChange={(e) => { const n = [...checks]; n[i] = e.target.checked; setChecks(n); }} /> {c}</label>)}
                <input placeholder="Why this trade?" value={thesis} onChange={(e) => setThesis(e.target.value)} />
                <button disabled={CHECKS.some((_, i) => !checks[i]) || !thesis.trim()}
                  onClick={async () => { await run({ action: "paper", symbol: card.symbol, thesis }); setCard(null); }}>Log paper trade</button>
              </>
            )}
          </Panel>
          <Panel title="Paper journal" note="scored daily" cls={vis("markets")}>
            {!s?.trades.length && <p className="dim small">No paper trades yet.</p>}
            {s?.trades.slice(0, 6).map((t) => <p key={t.id} className="small"><b>{t.symbol}</b> {t.entry} → SL {t.stop} / T {t.target} <span className={`st ${t.status}`}>{t.status}</span></p>)}
          </Panel>
          <Panel title="Ledger" note="your entries" cls={vis("markets")}>
            {!s?.ledger.length && <p className="dim small">“NOVA, 500 rupees kharch hua chai pe”</p>}
            {s?.ledger.slice(0, 5).map((l) => <p key={l.id} className="small"><span className={+l.amount >= 0 ? "up" : "down"}>{inr(+l.amount)}</span> {l.note}
              <X onClick={() => run({ action: "delete", table: "ledger", id: l.id })} /></p>)}
          </Panel>
          <Panel title="Contacts" note={`${s?.contacts.length ?? 0} saved`} cls={vis("mind")}>
            {!s?.contacts.length && <p className="dim small">“NOVA, Mummy ka number 98XXXXXXXX save karo” — then “Mummy ko call karo”.</p>}
            <div className="row wrap">{s?.contacts.map((c) => <span key={c.id} className="chip">{c.name} <X onClick={() => run({ action: "delete", table: "contacts", id: c.id })} /></span>)}</div>
          </Panel>
          <Panel title="Memory & learned rules" cls={vis("mind")}>
            {s?.memory.slice(0, 8).map((x) => <p key={x.id} className="small">🧠 {x.fact} <X onClick={() => run({ action: "delete", table: "memory", id: x.id })} /></p>)}
            {s?.addenda.map((x) => <p key={x.id} className="small">⚙ {x.text} <X onClick={() => run({ action: "delete", table: "addenda", id: x.id })} /></p>)}
            {!!s?.watchlist.length && <div className="row wrap">{s.watchlist.map((w) => <span key={w.symbol} className="chip">{w.symbol} <X onClick={() => run({ action: "delete", table: "watchlist", id: w.symbol })} /></span>)}</div>}
            {!s?.memory.length && !s?.addenda.length && <p className="dim small">“NOVA, yaad rakhna ki mera budget 10k hai”</p>}
          </Panel>
          <Panel title="Systems" cls={vis("system")}>
            <Sys ok={prov.length > 0} label="Brain" note={prov.length ? prov.join(" → ") : "Add NVIDIA_API_KEY or GROQ_API_KEY in Vercel"} />
            <Sys ok={v.supported} label="Voice & wake word" note="Chrome/Edge · screen kept awake while armed" />
            <Sys ok label="Action engine" note="WhatsApp · call · SMS · email · maps · YouTube · music · apps · calendar · timers · reminders · weather" />
            <Sys ok label="Market data" note="Yahoo daily candles, delayed" />
            <Sys ok={direct} label="Direct mode" note="Opens apps instantly; you press the final Send/Call" />
            <Sys label="Payments / banking" note="Blocked by design — NOVA never moves money" />
            <Sys label="Background control (screen closed)" note="Next: Telegram + Tasker bridge" />
          </Panel>
        </div>
      </section>

      <nav className="tabs">
        {([["core", "◉", "NOVA"], ["tasks", "✓", "Tasks"], ["markets", "₹", "Markets"], ["mind", "✦", "Mind"], ["system", "⚙", "System"]] as [Tab, string, string][])
          .map(([t, ic, l]) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}><span>{ic}</span>{l}
            {t === "tasks" && !!m?.pending && <em>{m.pending}</em>}</button>)}
      </nav>
    </main>
  );
}

function Typer({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const iv = setInterval(() => setN((x) => { if (x >= text.length) { clearInterval(iv); return x; } return x + 3; }), 16);
    return () => clearInterval(iv);
  }, [text]);
  return <>{text.slice(0, n)}{n < text.length && <span className="caret">▍</span>}</>;
}
const Panel = ({ title, note, cls = "", children }: { title: string; note?: string; cls?: string; children: React.ReactNode }) => (
  <div className={`panel ${cls}`}><h2>{title}{note && <small>{note}</small>}</h2>{children}</div>
);
const Tile = ({ k, v, hot }: { k: string; v: React.ReactNode; hot?: boolean }) => (
  <div className={`tile ${hot ? "hot" : ""}`}><span>{k}</span><b>{v}</b></div>
);
const Sys = ({ ok, label, note }: { ok?: boolean; label: string; note: string }) => (
  <div className={`sys ${ok ? "" : "off"}`}><i />{label}<small>{note}</small></div>
);
const X = ({ onClick }: { onClick: () => void }) => <button className="x" onClick={onClick} title="Remove">✕</button>;
const Diff = ({ p }: { p: Row }) => (
  <details><summary>A/B test on: “{p.payload.test_question}”</summary>
    <div className="diff"><div><em>Before</em>{p.payload.before}</div><div><em>After</em>{p.payload.after}</div></div>
  </details>
);
