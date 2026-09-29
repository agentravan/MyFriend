"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useJarvisVoice } from "@/hooks/useJarvisVoice";
import type { Snapshot, Row } from "@/lib/db";
import type { Analysis } from "@/lib/market";

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const todayIST = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const CHECKS = ["Risk ≤ 1–2% of capital on this trade", "Stop-loss decided before entry", "Reward:risk ≥ 2:1",
  "I can explain WHY in one line", "Not revenge / FOMO trading"];

async function api(body?: object) {
  const r = await fetch("/api/agent", body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (r.status === 401) { location.href = "/login"; throw new Error("auth"); }
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Request failed");
  return j;
}

export default function Home() {
  const [s, setS] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState(""), [daily, setDaily] = useState(false);
  const [input, setInput] = useState(""), [talk, setTalk] = useState(true);
  const [card, setCard] = useState<Analysis | null>(null), [checks, setChecks] = useState<boolean[]>([]), [thesis, setThesis] = useState("");
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const logRef = useRef<HTMLDivElement>(null), speakRef = useRef<(t: string) => void>(() => {});

  const run = useCallback(async (body: object) => {
    setErr("");
    try { const j = await api(body); setS(j.state); return j; } catch (e) { setErr((e as Error).message); }
  }, []);

  const send = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setBusy(true); setInput("");
    setS((p) => p && { ...p, messages: [...p.messages, { role: "user", content: text, id: Date.now() }] });
    const j = await run({ action: "chat", text });
    if (j?.card) { setCard(j.card); setChecks([]); setThesis(""); }
    if (j?.reply && talk) speakRef.current(j.reply);
    setBusy(false);
  }, [run, talk]);

  const v = useJarvisVoice(send);
  speakRef.current = v.speak;

  // Boot: load state, run the Daily Protocol once per IST day, notify if approvals are waiting.
  useEffect(() => {
    api().then(async (j) => {
      setS(j.state);
      if (j.state.digest?.day !== todayIST()) {
        setDaily(true);
        const d = await run({ action: "daily" });
        setDaily(false);
        if (d && "Notification" in window && Notification.permission === "granted" && d.state.metrics.pending)
          new Notification("NOVA · Daily briefing", { body: d.summary });
      }
    }).catch((e) => e.message !== "auth" && setErr(e.message));
  }, [run]);

  useEffect(() => { logRef.current?.scrollTo(0, 1e6); }, [s?.messages.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.altKey && e.key.toLowerCase() === "n") v.trigger(); };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [v]);

  const m = s?.metrics;
  const pending = s?.proposals.filter((p) => p.status === "pending") ?? [];
  const decided = s?.proposals.filter((p) => p.status !== "pending").slice(0, 6) ?? [];
  const state = busy || daily ? "thinking" : v.mode;

  return (
    <main className="shell">
      <header>
        <h1>NOVA<span>personal intelligence</span></h1>
        <div className="row">
          <span className={`chip ${state}`}>{{ off: "Voice off", sleeping: 'Say "NOVA…"', awake: "Listening", speaking: "Speaking", thinking: "Thinking" }[state]}</span>
          {v.supported
            ? <button onClick={v.mode === "off" ? v.start : v.stop}>{v.mode === "off" ? "🎙 Arm wake word" : "⏹ Disarm"}</button>
            : <span className="chip warn" title="Web Speech recognition needs Chrome or Edge">Voice: use Chrome/Edge</span>}
          <button onClick={() => setTalk(!talk)}>{talk ? "🔊 Voice replies" : "🔇 Muted"}</button>
          <button onClick={() => "Notification" in window && Notification.requestPermission()} title="Browser notifications for daily briefings">🔔</button>
          <a className="btn" href="/api/agent?export=1" title="Download a JSON backup of everything">⤓ Export</a>
        </div>
      </header>
      {err && <div className="err bar" onClick={() => setErr("")}>{err} ✕</div>}

      <section className="grid">
        {/* LEFT: metrics + approvals */}
        <div className="col">
          <div className="panel">
            <h2>Command metrics <small>real data only</small></h2>
            <div className="metrics">
              <Tile k="Pending approvals" v={m?.pending ?? "–"} hot={!!m?.pending} />
              <Tile k="Ideas approved" v={m?.ideasApproved ?? "–"} />
              <Tile k="Paper hit-rate" v={m?.hitRate == null ? "—" : `${m.hitRate}%`} sub={`${m?.closedTrades ?? 0} closed`} />
              <Tile k="Open paper trades" v={m?.openTrades ?? "–"} />
              <Tile k="Income (month)" v={m ? inr(m.monthIn) : "–"} sub="your entries" />
              <Tile k="Expense (month)" v={m ? inr(m.monthOut) : "–"} sub="your entries" />
            </div>
          </div>
          <div className="panel">
            <h2>Daily protocol <small>{daily ? "running…" : s?.digest?.day ?? "—"}</small></h2>
            <p className="dim">{s?.digest?.summary ?? "First briefing runs when you open NOVA today."}</p>
            <button disabled={daily} onClick={async () => { setDaily(true); await run({ action: "daily", force: true }); setDaily(false); }}>↻ Run again</button>
          </div>
          <div className="panel grow">
            <h2>Approval queue <small>{pending.length} awaiting you</small></h2>
            {!pending.length && <p className="dim">Nothing pending. Ask “NOVA, business ideas do” or wait for tomorrow’s briefing.</p>}
            {pending.map((p) => (
              <div key={p.id} className={`prop ${p.kind}`}>
                <div className="tag">{p.kind === "addendum" ? "self-improvement" : p.kind}</div>
                <b>{p.title}</b>
                <p>{p.body}</p>
                {p.kind === "addendum" && <Diff p={p} />}
                <input placeholder="Reason (required to reject — NOVA learns from it)" value={reasons[p.id] ?? ""}
                  onChange={(e) => setReasons({ ...reasons, [p.id]: e.target.value })} />
                <div className="row">
                  <button className="ok" onClick={() => run({ action: "decide", id: p.id, approve: true, reason: reasons[p.id] })}>✓ Approve</button>
                  <button className="no" onClick={() => run({ action: "decide", id: p.id, approve: false, reason: reasons[p.id] })}>✕ Reject</button>
                </div>
              </div>
            ))}
            {!!decided.length && <details><summary>Recent decisions</summary>
              {decided.map((p) => <p key={p.id} className="dim small">{p.status === "approved" ? "✓" : "✕"} {p.title}{p.reason ? ` — “${p.reason}”` : ""}</p>)}
            </details>}
          </div>
        </div>

        {/* CENTER: reactor + conversation */}
        <div className="col center">
          <button className={`reactor ${state}`} onClick={v.trigger} title="Tap or Alt+N to talk"><i /><i /><i /><b /></button>
          <p className="interim">{v.interim || (state === "awake" ? "Bolo Boss…" : " ")}</p>
          <div className="panel grow chat" ref={logRef}>
            {s?.messages.map((x) => <div key={x.id} className={`msg ${x.role}`}>{x.content}</div>)}
            {busy && <div className="msg assistant dim">…</div>}
          </div>
          <form className="ask" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type in English or Hinglish — e.g. “Reliance ka setup samjhao”" />
            <button disabled={busy || !input.trim()}>Send</button>
          </form>
        </div>

        {/* RIGHT: market, journal, memory, systems */}
        <div className="col">
          <div className="panel">
            <h2>Market lens <small>delayed · educational</small></h2>
            {!card ? <p className="dim">Ask “NOVA, TCS analyse karo”. Indicators are computed in code; NOVA only explains them.</p> : (
              <>
                <div className="quote"><b>{card.symbol}</b> {card.currency} {card.price}
                  <span className={card.changePct >= 0 ? "up" : "down"}> {card.changePct >= 0 ? "▲" : "▼"} {card.changePct}%</span></div>
                <div className="kv">
                  <span>RSI 14</span><b>{card.rsi14} · {card.rsiNote}</b>
                  <span>SMA 20/50</span><b>{card.sma20} / {card.sma50}</b>
                  <span>Trend</span><b>{card.trend}</b>
                  <span>ATR 14</span><b>{card.atr14}</b>
                  <span>Vol vs 20d</span><b>{card.volRatio}×</b>
                  <span>6m range</span><b>{card.low6m} – {card.high6m}</b>
                </div>
                <p className="dim small">Data as of {new Date(card.asOf).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Not investment advice.</p>
                <h3>Paper-trade template (1.5×ATR stop, 2:1)</h3>
                <p className="small">Entry {card.paper.entry} · Stop {card.paper.stop} · Target {card.paper.target}</p>
                {CHECKS.map((c, i) => (
                  <label key={c} className="check"><input type="checkbox" checked={!!checks[i]}
                    onChange={(e) => { const n = [...checks]; n[i] = e.target.checked; setChecks(n); }} /> {c}</label>
                ))}
                <input placeholder="Why this trade? (one line)" value={thesis} onChange={(e) => setThesis(e.target.value)} />
                <button disabled={CHECKS.some((_, i) => !checks[i]) || !thesis.trim()}
                  onClick={async () => { await run({ action: "paper", symbol: card.symbol, thesis }); setCard(null); }}>Log paper trade</button>
              </>
            )}
          </div>
          <div className="panel">
            <h2>Paper journal <small>scored daily</small></h2>
            {!s?.trades.length && <p className="dim">No paper trades yet.</p>}
            {s?.trades.slice(0, 6).map((t) => (
              <p key={t.id} className="small"><b>{t.symbol}</b> {t.entry} → SL {t.stop} / T {t.target} <span className={`st ${t.status}`}>{t.status}</span></p>
            ))}
          </div>
          <div className="panel">
            <h2>Ledger <small>say “NOVA, 500 rupees kharch hua chai pe”</small></h2>
            {s?.ledger.slice(0, 5).map((l) => (
              <p key={l.id} className="small"><span className={+l.amount >= 0 ? "up" : "down"}>{+l.amount >= 0 ? "+" : ""}{inr(+l.amount)}</span> {l.note}
                <X onClick={() => run({ action: "delete", table: "ledger", id: l.id })} /></p>
            ))}
          </div>
          <div className="panel">
            <h2>Memory & learned rules</h2>
            {s?.memory.slice(0, 6).map((x) => <p key={x.id} className="small">🧠 {x.fact} <X onClick={() => run({ action: "delete", table: "memory", id: x.id })} /></p>)}
            {s?.addenda.map((x) => <p key={x.id} className="small">⚙ {x.text} <X onClick={() => run({ action: "delete", table: "addenda", id: x.id })} /></p>)}
            {!!s?.watchlist.length && <div className="row wrap">{s.watchlist.map((w) =>
              <span key={w.symbol} className="chip">{w.symbol} <X onClick={() => run({ action: "delete", table: "watchlist", id: w.symbol })} /></span>)}</div>}
            {!s?.memory.length && !s?.addenda.length && <p className="dim small">Say “NOVA, yaad rakhna ki mera budget 10k hai”.</p>}
          </div>
          <div className="panel">
            <h2>Systems</h2>
            <Sys ok label="Brain" note="Groq → Gemini fallback (Gemini never sees memory/ledger)" />
            <Sys ok={v.supported} label="Voice & wake word" note="Chrome/Edge, tab open; audio processed by browser vendor" />
            <Sys ok label="Market data" note="Yahoo daily candles, delayed; may rate-limit" />
            <Sys ok label="Notifications" note="Browser notifications on daily briefing" />
            <Sys label="Device / OS control" note="Not built — needs a local allow-listed companion" />
            <Sys label="Autonomous ops · bank/broker links" note="Not built — everything goes via approvals" />
            <Sys label="Live quotes · buy/sell signals" note="Not built — by design" />
          </div>
        </div>
      </section>
    </main>
  );
}

const Tile = ({ k, v, sub, hot }: { k: string; v: React.ReactNode; sub?: string; hot?: boolean }) => (
  <div className={`tile ${hot ? "hot" : ""}`}><span>{k}</span><b>{v}</b>{sub && <small>{sub}</small>}</div>
);
const Sys = ({ ok, label, note }: { ok?: boolean; label: string; note: string }) => (
  <div className={`sys ${ok ? "" : "off"}`}><i />{label}<small>{note}</small></div>
);
const X = ({ onClick }: { onClick: () => void }) => <button className="x" onClick={onClick} title="Remove">✕</button>;
const Diff = ({ p }: { p: Row }) => (
  <details open><summary>Test result on your question: “{p.payload.test_question}”</summary>
    <div className="diff"><div><em>Before</em>{p.payload.before}</div><div><em>After (with new rule)</em>{p.payload.after}</div></div>
  </details>
);
