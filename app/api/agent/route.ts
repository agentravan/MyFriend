// NOVA core brain: Hinglish/English intent routing, stock analysis, idea engine, approvals, self-improvement.
import { NextResponse } from "next/server";
import { llm, Msg, providers, health } from "@/lib/llm";
import { searchEngine } from "@/lib/web";
import { plan, execServer } from "@/lib/tools";
import { analyze, findSymbol } from "@/lib/market";
import { del, ins, sel, snapshot, upd } from "@/lib/db";
import { generateIdeas, persona, runDaily } from "@/lib/nova";
import { linkPhone, phone, PhoneOp, setSetting } from "@/lib/phone";
import { audit, resetFlags } from "@/lib/guard";
import { createTask } from "@/lib/agents";
import { paperPnl } from "@/lib/market";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const has = (re: RegExp, s: string) => re.test(s);
const R = {
  remember: /(remember that|remember:|yaad rakh|याद रख)/i,
  learn: /^(nova[,\s]+)?((learn|lesson|rule|seekh(o| lo| lena)?)\s*:|seekh lo\b|next time\b|agli baar\b|galti mat\b)\s*,?\s*/i,
  money: /(₹|\brs\.?|rupe(e|es|y)|रुपय|रुपये|रुपए)\s*([\d,]+(\.\d+)?)|([\d,]+(\.\d+)?)\s*(₹|rs\b|rupe(e|es)|रुपय|रुपये|रुपए)/i,
  expense: /(expense|spent|kharch|kharcha|diya|paid|bill|खर्च|दिया)/i,
  income: /(income|earned|kamaya|kamai|mila|received|got paid|कमाई|मिला)/i,
  watch: /(watch ?list|वॉचलिस्ट)/i,
  stock: /(stock|share|शेयर|स्टॉक|analy[sz]|chart|rsi|setup|price|bhav|भाव|nifty|sensex|निफ्टी|सेंसेक्स|trade|market)/i,
  idea: /((business|income|kamai|side hustle|dhanda|earn).{0,30}(idea|ideas|plan|suggest|batao|bata)|(idea|ideas|आइडिया).{0,30}(business|income|kamai|earn|paise)|paise kaise kamaye|income stream|बिज़नेस आइडिया|बिजनेस आइडिया)/i,
  act: /(open|khol|call|phone|whatsapp|message|msg|bhej|send|play|chala|laga|set|timer|alarm|remind|yaad dila|navigate|rasta|le chalo|search|dhoondh|save|number)/i,
};

async function handle(text: string, voice = false) {
  // 1) Memory
  if (has(R.remember, text)) {
    const fact = text.replace(/.*?(remember that|remember:|yaad rakhna|yaad rakho|yaad rakh|याद रखना|याद रखो|याद रख)\s*(ki|कि)?/i, "").trim() || text;
    await ins("memory", { fact });
    return { reply: `Done Boss, yaad rakh liya: "${fact}".` };
  }
  // 1b) Learnings — the Boss teaches NOVA a rule every agent follows from now on
  if (has(R.learn, text) && text.replace(R.learn, "").trim().length > 8) {
    const rule = text.replace(R.learn, "").trim().slice(0, 300);
    const scope = /lead|client|website|company|prospect/i.test(rule) ? "leads" : /research|source/i.test(rule) ? "research" : /mail|message|whatsapp|draft|tone/i.test(rule) ? "writing" : "general";
    await ins("learnings", { rule, scope, source: "user" });
    await audit(voice ? "voice" : "chat", "learned", rule);
    return { reply: `Seekh liya, Boss. Ab se har mission mein: "${rule}".` };
  }
  // 2) Ledger (user-entered money only)
  const m = text.match(R.money);
  if (m && (has(R.expense, text) || has(R.income, text))) {
    const amt = Number((m[3] ?? m[5]).replace(/,/g, "")) * (has(R.expense, text) ? -1 : 1);
    await ins("ledger", { amount: amt, note: text.slice(0, 140) });
    return { reply: `Ledger updated: ${amt > 0 ? "+" : "−"}₹${Math.abs(amt).toLocaleString("en-IN")} (${amt > 0 ? "income" : "expense"}). Dashboard pe dikh raha hai.` };
  }
  // 3) Watchlist
  const sym = findSymbol(text);
  if (has(R.watch, text) && sym) {
    await ins("watchlist", { symbol: sym }).catch(() => null);
    return { reply: `${sym} watchlist mein add. Daily briefing mein iska snapshot milega.` };
  }
  // 4) Stock analysis — numbers computed in code, LLM only explains
  const bareTicker = /^[A-Z][A-Z0-9&]{1,14}(\.(NS|BO))?$/.test(text.trim());
  if (sym && (bareTicker || (has(R.stock, text) && !has(R.act, text)))) {
    try {
      const a = await analyze(sym);
      const { system } = await persona();
      const { text: reply } = await llm({ system, maxTokens: 350, msgs: [{ role: "user", content:
        `${text}\n\nDATA (computed from delayed daily candles, as of ${new Date(a.asOf).toISOString()}):\n${JSON.stringify(a)}\n` +
        `Explain what these indicators say in 3-5 short sentences, add one risk-management lesson, and end with a one-line reminder this is educational, not advice.` }] });
      return { reply, card: a };
    } catch (e) {
      return { reply: `${sym} ka data abhi nahi mila (${(e as Error).message}). Symbol check karo, jaise TATAPOWER ya IRFC.` };
    }
  }
  if (has(R.stock, text) && /(analy|setup|rsi|chart)/i.test(text))
    return { reply: "Kaunsa stock, Boss? NSE symbol ya naam bolo — jaise Reliance, TCS, ya TATAPOWER." };
  // 5) Ideas → Approval Queue
  if (has(R.idea, text)) {
    const ideas = await generateIdeas(text);
    return { reply: ideas.length
      ? `${ideas.length} ideas Approval Queue mein daal diye: ${ideas.map((i) => i.title).join("; ")}. Approve ya reject karo — reason doge toh main seekhungi.`
      : "Ideas generate nahi ho paaye, brain busy hai. Thodi der baad try karo." };
  }
  // 6) Everything else → action planner (chat answer + optional whitelisted actions)
  const { system, privateCtx } = await persona();
  const [histRows, contacts] = await Promise.all([sel("messages", "order=at.desc&limit=8"), sel("contacts", "select=name&limit=200")]);
  const hist = histRows.reverse().map((x) => ({ role: x.role, content: x.content })) as Msg[];
  const ctx = privateCtx + (contacts.length ? `\nSAVED CONTACT NAMES: ${contacts.map((c) => c.name).join(", ")}` : "");
  const { reply, actions, provider } = await plan(text, hist, system, ctx);
  const extra = await execServer(actions, { voice });
  const pending = actions.find((a) => a.kind === "task" && (a as { via?: string }).via === "confirm");
  if (pending && pending.kind === "task") return { reply: `Mission: ${pending.goal}. Start karun, Boss?`, actions, provider };
  const weatherOnly = actions.length > 0 && actions.every((a) => a.kind === "weather");
  return { reply: weatherOnly ? extra : [reply, extra].filter(Boolean).join(" "), actions, provider };
}

async function decide(id: number, approve: boolean, reason: string) {
  const [p] = await upd("proposals", `id=eq.${id}&status=eq.pending`, {
    status: approve ? "approved" : "rejected", reason: reason || null, decided_at: new Date().toISOString(),
  });
  if (p && approve && p.kind === "addendum") await ins("addenda", { text: p.payload.rule });
  if (p && approve && p.kind === "next") await createTask(p.payload.goal, undefined, { source: "chat", depth: p.payload.depth ?? 1 });
  if (p && !approve && reason) await ins("learnings", { rule: `Boss rejected "${p.title}" because: ${reason}`, scope: "general", source: "user" }).catch(() => null);
  if (p) await audit("chat", approve ? "approved" : "rejected", `${p.title}${reason ? ` — ${reason}` : ""}`);
}

const DELETABLE = new Set(["memory", "addenda", "watchlist", "ledger", "contacts", "reminders", "learnings"]);

export async function POST(req: Request) {
  try {
    const b = await req.json();
    let out: Record<string, unknown> = {};
    switch (b.action) {
      case "chat": {
        const text = String(b.text ?? "").slice(0, 1500).trim();
        if (!text) break;
        await ins("messages", { role: "user", content: text });
        out = await handle(text, !!b.voice);
        await ins("messages", { role: "assistant", content: String(out.reply) });
        break;
      }
      case "decide":
        if (!b.approve && !String(b.reason ?? "").trim())
          return NextResponse.json({ error: "Reject karne ke liye reason zaroori hai — isi se NOVA seekhti hai." }, { status: 400 });
        await decide(Number(b.id), !!b.approve, String(b.reason ?? "").slice(0, 300)); break;
      case "paper": { // user-initiated paper trade from a computed template
        const a = await analyze(String(b.symbol));
        await ins("trades", { symbol: a.symbol, ...a.paper, thesis: String(b.thesis ?? "").slice(0, 300) });
        out = { reply: `Paper trade logged: ${a.symbol} entry ₹${a.paper.entry}, stop ₹${a.paper.stop}, target ₹${a.paper.target}. Daily scoring karungi.` };
        break;
      }
      case "daily": out = await runDaily(!!b.force); break;
      case "contact": // from the phone's contact picker
        await ins("contacts", { name: String(b.name).slice(0, 60), phone: String(b.phone).replace(/[^\d+]/g, "") }).catch(() => null); break;
      case "phone_setup": await linkPhone(String(b.url ?? "")); out = { reply: "Phone Link connected, Boss. Test call bhejun?" }; break;
      case "phone": await phone(b.op as PhoneOp, { number: b.number, text: b.text, name: b.name }); out = { reply: "Done, Boss." }; break;
      case "power": {
        const on = !!b.on;
        await setSetting("nova_enabled", on ? "on" : "off"); resetFlags();
        await audit("system", on ? "resumed" : "paused", on ? "Boss resumed NOVA" : "Boss pressed the master stop — every action, call and mission is frozen");
        out = { reply: on ? "Back online, Boss. Missions continue." : "Sab rok diya, Boss. Koi call, message ya mission nahi chalega jab tak aap Resume nahi karte." };
        break;
      }
      case "autopilot":
        await setSetting("autopilot", b.on ? "on" : "off"); resetFlags();
        await audit("system", "autopilot", b.on ? "Autopilot ON — NOVA starts her top next move after each mission" : "Autopilot OFF");
        break;
      case "events_seen": await upd("device_events", "seen=eq.false", { seen: true }); break;
      case "reminder_done": await upd("reminders", `id=eq.${Number(b.id)}`, { done: true }); break;
      case "delete":
        if (DELETABLE.has(b.table)) await del(b.table, `${b.table === "watchlist" ? "symbol" : "id"}=eq.${encodeURIComponent(b.id)}`);
        break;
    }
    return NextResponse.json({ ...out, state: await snapshot() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    if (new URL(req.url).searchParams.has("pnl")) return NextResponse.json(await paperPnl());
    if (new URL(req.url).searchParams.has("health")) return NextResponse.json({ health: await health(), search: searchEngine() });
    const state = await snapshot();
    if (new URL(req.url).searchParams.has("export"))
      return new NextResponse(JSON.stringify(state, null, 2), {
        headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename=nova-backup-${Date.now()}.json` },
      });
    return NextResponse.json({ state, providers: providers() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
