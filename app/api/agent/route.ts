// NOVA core brain: Hinglish/English intent routing, stock analysis, idea engine, approvals, self-improvement.
import { NextResponse } from "next/server";
import { llm, Msg, providers } from "@/lib/llm";
import { plan, execServer } from "@/lib/tools";
import { analyze, findSymbol } from "@/lib/market";
import { del, ins, sel, snapshot, upd } from "@/lib/db";
import { generateIdeas, persona, runDaily } from "@/lib/nova";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const has = (re: RegExp, s: string) => re.test(s);
const R = {
  remember: /(remember that|remember:|yaad rakh|याद रख)/i,
  money: /(₹|\brs\.?|rupe(e|es|y)|रुपय|रुपये|रुपए)\s*([\d,]+(\.\d+)?)|([\d,]+(\.\d+)?)\s*(₹|rs\b|rupe(e|es)|रुपय|रुपये|रुपए)/i,
  expense: /(expense|spent|kharch|kharcha|diya|paid|bill|खर्च|दिया)/i,
  income: /(income|earned|kamaya|kamai|mila|received|got paid|कमाई|मिला)/i,
  watch: /(watch ?list|वॉचलिस्ट)/i,
  stock: /(stock|share|शेयर|स्टॉक|analy[sz]|chart|rsi|setup|price|bhav|भाव|nifty|sensex|निफ्टी|सेंसेक्स|trade|market)/i,
  idea: /((business|income|kamai|side hustle|dhanda|earn).{0,30}(idea|ideas|plan|suggest|batao|bata)|(idea|ideas|आइडिया).{0,30}(business|income|kamai|earn|paise)|paise kaise kamaye|income stream|बिज़नेस आइडिया|बिजनेस आइडिया)/i,
  act: /(open|khol|call|phone|whatsapp|message|msg|bhej|send|play|chala|laga|set|timer|alarm|remind|yaad dila|navigate|rasta|le chalo|search|dhoondh|save|number)/i,
};

async function handle(text: string) {
  // 1) Memory
  if (has(R.remember, text)) {
    const fact = text.replace(/.*?(remember that|remember:|yaad rakhna|yaad rakho|yaad rakh|याद रखना|याद रखो|याद रख)\s*(ki|कि)?/i, "").trim() || text;
    await ins("memory", { fact });
    return { reply: `Done Boss, yaad rakh liya: "${fact}".` };
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
  const extra = await execServer(actions);
  const weatherOnly = actions.length > 0 && actions.every((a) => a.kind === "weather");
  return { reply: weatherOnly ? extra : [reply, extra].filter(Boolean).join(" "), actions, provider };
}

async function decide(id: number, approve: boolean, reason: string) {
  const [p] = await upd("proposals", `id=eq.${id}&status=eq.pending`, {
    status: approve ? "approved" : "rejected", reason: reason || null, decided_at: new Date().toISOString(),
  });
  if (p && approve && p.kind === "addendum") await ins("addenda", { text: p.payload.rule });
}

const DELETABLE = new Set(["memory", "addenda", "watchlist", "ledger", "contacts", "reminders"]);

export async function POST(req: Request) {
  try {
    const b = await req.json();
    let out: Record<string, unknown> = {};
    switch (b.action) {
      case "chat": {
        const text = String(b.text ?? "").slice(0, 1500).trim();
        if (!text) break;
        await ins("messages", { role: "user", content: text });
        out = await handle(text);
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
