// NOVA task engine: Orchestrator plans → specialist agents execute step by step → testing → delivery.
// Each tick runs ONE step (fits serverless time limits). Ticks come from the open app and from Supabase pg_cron.
import { llm, parseJSON } from "@/lib/llm";
import { ins, sel, upd, Row } from "@/lib/db";
import { read, search, Hit } from "@/lib/web";
import { persona } from "@/lib/nova";
import { audit, autopilot, enabled } from "@/lib/guard";

export const AGENTS = ["research", "business", "hr", "data", "coding", "testing", "document", "communication", "manual"] as const;
export type Agent = (typeof AGENTS)[number];
export const AGENT_LABEL: Record<string, string> = {
  research: "Research Agent", business: "Business Agent", hr: "HR Agent", data: "Data Agent", coding: "Coding Agent",
  testing: "Testing Agent", document: "Document Agent", communication: "Communication Agent", manual: "You",
};
const PHASE: Record<string, string> = {
  research: "Researching", business: "Analyzing", hr: "Analyzing", data: "Organizing data", coding: "Building",
  testing: "Testing", document: "Writing", communication: "Drafting", manual: "Waiting for you",
};
const now = () => new Date().toISOString();

// ───────────────────────────── Orchestrator: plan ─────────────────────────────
const PLAN_PROMPT = `You are NOVA's Orchestrator. Turn the user's goal into an executable plan for internal agents.
Agents: research (web search + read pages + notes with sources), business (strategy, offers, pricing, plans), hr (HR/payroll/compliance India),
data (structured tables → CSV file), coding (build ONE self-contained HTML app/dashboard/website file), testing (verify & fix the last built file),
document (write a polished report/proposal/plan → HTML + Markdown files), communication (draft emails/WhatsApp/LinkedIn messages — never sends),
manual (ONLY for things NOVA truly cannot do: OTP, login, CAPTCHA, payments, sending from the user's own accounts, physical actions; and only if a LATER step depends on it).
For finding clients/leads: research (find real businesses via directories, lists, news) → research (their official websites/contact pages) → data (CSV lead sheet) → communication (personalised outreach drafts) → document (summary + how to approach).
Rules: 3–7 steps. Prefer automatic steps. After every coding step add a testing step. Put research before building/writing when facts are needed.
Every step's instruction must be specific and self-contained. Assume India / INR / Hinglish-friendly unless told otherwise.
Output ONLY JSON: {"title":"<short task title>","kind":"research|build|leads|document|analysis|general","steps":[{"agent":"...","title":"<5-8 words>","instruction":"..."}]}`;

export async function planTask(t: Row) {
  const { text } = await llm({
    system: PLAN_PROMPT, json: true, strict: true, maxTokens: 1200, temperature: 0.3, timeoutMs: 60000,
    msgs: [{ role: "user", content: `GOAL: ${t.goal}${t.attachment ? `\n\nATTACHED FILE (excerpt):\n${String(t.attachment).slice(0, 3000)}` : ""}` }],
  });
  const p = parseJSON<{ title?: string; kind?: string; steps?: { agent: string; title: string; instruction: string }[] }>(text, {});
  let steps = (p.steps ?? []).filter((s) => (AGENTS as readonly string[]).includes(s.agent) && s.title).slice(0, 8);
  if (!steps.length) steps = [{ agent: "research", title: "Research the goal", instruction: t.goal }, { agent: "document", title: "Write the result", instruction: t.goal }];
  // Guarantee a test after each coding step
  steps = steps.flatMap((s, i) => s.agent === "coding" && steps[i + 1]?.agent !== "testing"
    ? [s, { agent: "testing", title: "Test and fix the build", instruction: "Verify the file works; fix any errors." }] : [s]);
  await ins("steps", steps.map((s, i) => ({ task_id: t.id, idx: i, agent: s.agent, title: s.title.slice(0, 80),
    instruction: s.instruction ?? "", manual: s.agent === "manual" })));
  await upd("tasks", `id=eq.${t.id}`, { title: (p.title || t.title).slice(0, 90), kind: p.kind ?? "general", status: "running",
    phase: PHASE[steps[0].agent], updated_at: now() });
}

// ───────────────────────────── Agents ─────────────────────────────
type Ctx = { task: Row; step: Row; prior: string; system: string; learn?: string };
type Out = { output: string; files?: { name: string; mime: string; content: string }[]; waitUser?: string };

const context = (c: Ctx) =>
  `TASK GOAL: ${c.task.goal}\nCURRENT STEP (${AGENT_LABEL[c.step.agent]}): ${c.step.title}\nINSTRUCTION: ${c.step.instruction}\n` +
  (c.task.attachment ? `\nATTACHED FILE:\n${String(c.task.attachment).slice(0, 12000)}\n` : "") +
  (c.prior ? `\nRESULTS FROM EARLIER STEPS:\n${c.prior}` : "") +
  (c.learn ? `\n\nLESSONS FROM THE BOSS (always follow):\n${c.learn}` : "");

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 36).replace(/^-+|-+$/g, "") || "nova";

async function research(c: Ctx): Promise<Out> {
  const leads = /client|lead|prospect|customer|compan|business|contact|vendor|supplier|firm|agenc/i.test(c.step.instruction + c.task.goal);
  const ask = async (prompt: string) => parseJSON<{ queries?: string[] }>((await llm({ system: "You write precise web search queries. Output JSON only.", json: true,
    maxTokens: 300, prefer: "fast", strict: true, msgs: [{ role: "user", content: prompt }] })).text, {}).queries?.slice(0, 4) ?? [];
  const seen = new Set<string>(), hits: Hit[] = [], answers: Hit[] = [];
  // Enrichment mode: earlier steps already listed companies → look each one up individually for website/contact info.
  const enrich = leads && /contact|website|email|phone|detail|enrich/i.test(c.step.instruction + c.step.title) && /\|/.test(c.prior);
  if (enrich) {
    const { text } = await llm({ system: "Extract organisations from research notes. Output JSON only.", json: true, maxTokens: 900, prefer: "fast", strict: true,
      msgs: [{ role: "user", content: `From these notes, list up to 15 distinct organisations with their city/area.\n${c.prior.slice(0, 9000)}\nJSON: {"orgs":[{"name":"","city":""}]}` }] });
    const orgs = parseJSON<{ orgs?: { name: string; city?: string }[] }>(text, {}).orgs?.filter((o) => o?.name).slice(0, 15) ?? [];
    for (let i = 0; i < orgs.length; i += 5) {
      const batch = await Promise.all(orgs.slice(i, i + 5).map((o) => search(`"${o.name}" ${o.city ?? ""} official website contact phone email`, 3).catch(() => [])));
      batch.forEach((hs, k) => hs.forEach((h) => { if (h.url && !seen.has(h.url)) { seen.add(h.url); hits.push({ ...h, title: `${orgs[i + k].name} → ${h.title}` }); } }));
    }
  }
  const gather = async (qs: string[]) => {
    for (const h of (await Promise.all(qs.map((q) => search(q, 8)))).flat()) {
      if (!h.url) answers.push(h); else if (!seen.has(h.url)) { seen.add(h.url); hits.push(h); }
    }
  };
  // Round 1 (skipped in enrichment mode)
  const q1 = enrich ? [] : await ask(`${context(c)}\n\nWrite 4 web search queries (India-focused if relevant).${leads ? " Target real, specific businesses: directories (Justdial, IndiaMART, Clutch, LinkedIn company pages), 'list of … companies in <city>', industry associations, recent news of hiring/expansion." : ""} JSON: {"queries":["..."]}`);
  if (!enrich) await gather(q1.length ? q1 : [c.step.title]);
  // Round 2: fill gaps found in round 1
  const q2 = enrich ? [] : await ask(`${context(c)}\n\nRound-1 results (titles):\n${hits.slice(0, 20).map((h) => "- " + h.title).join("\n") || "(none)"}\n\nWrite up to 3 follow-up queries that fill the biggest gaps${leads ? " (e.g. specific company names + \"contact\", official websites, city-specific directories)" : ""}. JSON: {"queries":["..."]}`);
  if (q2.length && !enrich) await gather(q2);
  // Read the best pages (Tavily already returns page text; others are fetched)
  const pages = await Promise.all(hits.slice(0, enrich ? 30 : 8).map(async (h) => ({ ...h, body: h.body || (enrich ? h.snippet : await read(h.url, 3500)) })));
  const corpus = [
    ...answers.slice(0, 2).map((a) => `[G] ${a.title}\n${a.snippet}`),
    ...pages.map((p, i) => `[${i + 1}] ${p.title} — ${p.url}\n${(p.body || p.snippet).slice(0, enrich ? 850 : 2800)}`),
    ...(enrich ? [] : hits.slice(8, 24).map((h, i) => `[${i + 9}] ${h.title} — ${h.url}\n${h.snippet}`)),
  ].join("\n\n").slice(0, 26000);
  if (!corpus) return { output: `Web search returned no results (${[...q1, ...q2].join(" | ")}). Check TAVILY_API_KEY in Vercel.` };
  const { text: notes } = await llm({ system: c.system + "\nYou are NOVA's Research Agent. Use ONLY the sources given; cite as [n]. Never invent companies, people, numbers, emails or phone numbers. Output only the findings — no agent name, no meta commentary." +
      (leads ? " For leads: list EVERY distinct real business found (aim for 15–30) as a table: Name | What they do | City | Website | Phone/Email (only if shown in the source) | Why relevant | Source [n]. Leave unknown cells blank (no 'Not available' text)." : ""),
    maxTokens: 3500, timeoutMs: 150000, strict: true,
    msgs: [{ role: "user", content: `${context(c)}\n\nSOURCES (web, fetched ${now().slice(0, 10)}; ${hits.length} results from ${q1.length + q2.length} searches):\n${corpus}\n\nWrite concise research notes that answer the instruction. End with a "Sources" list of [n] title — url.` }] });
  return { output: notes };
}

async function think(c: Ctx, role: string): Promise<Out> {
  const { text } = await llm({ system: `${c.system}\nYou are NOVA's ${AGENT_LABEL[c.step.agent]}. ${role} Be concrete and practical; use only facts from earlier steps for real-world claims. Output only the deliverable — no agent name heading, no meta commentary.`,
    maxTokens: 3000, timeoutMs: 120000, strict: true, msgs: [{ role: "user", content: context(c) }] });
  return { output: text };
}

async function data(c: Ctx): Promise<Out> {
  // The model returns structured rows; CSV is built in code so quoting is always correct (addresses contain commas).
  const { text } = await llm({ system: `You are NOVA's Data Agent. Output ONLY JSON: {"columns":["..."],"rows":[["..."]]}. Include EVERY record found in the earlier steps — do not drop any; merge duplicates of the same organisation. Use only facts present in the context; unknown cells are "" (never "Not available"/"N/A"). Never invent emails or phone numbers.`,
    json: true, maxTokens: 6000, timeoutMs: 150000, prefer: "fast", strict: true, msgs: [{ role: "user", content: context(c) }] });
  const t = parseJSON<{ columns?: string[]; rows?: unknown[][] }>(text, {});
  const cols = t.columns?.length ? t.columns : [];
  const rows = (t.rows ?? []).filter((r) => Array.isArray(r) && r.some((v) => String(v ?? "").trim()));
  if (!cols.length || !rows.length) throw new Error("Data Agent returned no table");
  const verified = await verifySites(cols, rows);
  if (verified) cols.push("Website check");
  const cell = (v: unknown) => { const x = String(v ?? "").replace(/^(not (available|shown)( in source)?|n\/a|-|–)$/i, "").trim(); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const csv = "\uFEFF" + [cols, ...rows.map((r) => cols.map((_, i) => r[i]))].map((r) => r.map(cell).join(",")).join("\r\n");
  return { output: `Built a table with ${rows.length} rows and ${cols.length} columns: ${cols.join(", ")}.${verified ? ` Websites checked: ${verified}.` : ""}`,
    files: [{ name: `${slug(c.task.title)}-table.csv`, mime: "text/csv", content: csv }] };
}

/** Lead accuracy: open every website in the table and check it is live and actually mentions the company. Appends a result cell per row. */
async function verifySites(cols: string[], rows: unknown[][]) {
  const w = cols.findIndex((c) => /website|url|domain|site/i.test(c));
  if (w < 0) return "";
  const n = Math.max(0, cols.findIndex((c) => /name|company|organi[sz]ation|business|firm/i.test(c)));
  const words = (name: string) => name.toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|india|the|co|company|group|industries|and)\b/g, " ")
    .split(/[^a-z0-9]+/).filter((x) => x.length > 2);
  const check = async (r: unknown[]) => {
    let url = String(r[w] ?? "").trim();
    if (!url) return "no website";
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const keys = words(String(r[n] ?? ""));
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36" } });
      if (!res.ok && res.status !== 403) return `✗ site error ${res.status}`;
      const text = res.ok ? (await res.text()).slice(0, 200000).toLowerCase() : "";
      const hit = keys.some((k) => host.includes(k) || text.includes(k));
      return res.status === 403 ? (keys.some((k) => host.includes(k)) ? "✓ live (bot-protected)" : "? bot-protected, verify") : hit ? "✓ verified" : "⚠ name not on site — check";
    } catch { return "✗ unreachable"; }
  };
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += 8) out.push(...(await Promise.all(rows.slice(i, i + 8).map(check))));
  rows.forEach((r, i) => { while (r.length < cols.length) r.push(""); r.push(out[i]); });
  const ok = out.filter((x) => x.startsWith("✓")).length, bad = out.filter((x) => /^[✗⚠?]/.test(x)).length;
  return `${ok} verified, ${bad} need a look`;
}

const md2html = (md: string, title: string) => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = esc(md)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(https?:\/\/[^\s)<]+)/g, '<a href="$1" target="_blank">$1</a>')
    .replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>").replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "</p><p>");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#10202c;background:#f7fbfd}h1,h2,h3{color:#063a55}h1{border-bottom:3px solid #00b8d4;padding-bottom:8px}a{color:#0077a8}li{margin:4px 0}footer{margin-top:40px;color:#789;font-size:13px}</style></head>
<body><p>${body}</p><footer>Prepared by NOVA · ${new Date().toLocaleDateString("en-IN")}</footer></body></html>`;
};

async function document(c: Ctx): Promise<Out> {
  const { text } = await llm({ system: `${c.system}\nYou are NOVA's Document Agent. Write a polished, well-structured Markdown document (# title, ## sections, bullet lists, tables where useful). Use only facts from earlier steps; keep source links. Start directly with "# <title>" — no agent name, no meta commentary. If earlier steps found little, still deliver the best useful document from what exists and add a short "Next steps" section.`,
    maxTokens: 5000, timeoutMs: 200000, prefer: "fast", strict: true, msgs: [{ role: "user", content: context(c) }] });
  const md = text.replace(/^\s*\*\*[^*\n]+\.(md|markdown)\*\*\s*$/gim, "").replace(/```(markdown|md)?\s*\n?/gi, "").trim();
  const title = md.match(/^# (.+)$/m)?.[1] ?? c.task.title, base = slug(title);
  return { output: md.slice(0, 1500) + (md.length > 1500 ? "\n…" : ""),
    files: [{ name: `${base}.html`, mime: "text/html", content: md2html(md, title) }, { name: `${base}.md`, mime: "text/markdown", content: md }] };
}

const CODER = `You are NOVA's Coding Agent. Build ONE complete, self-contained HTML file (inline CSS + JS).
Allowed external scripts ONLY from https://cdn.jsdelivr.net/npm/ (e.g. chart.js@4). Realistic sample data if none is provided (clearly labelled "sample").
Must be responsive, polished, dark futuristic style unless told otherwise, no build step, no placeholders like "TODO".
Output ONLY the HTML document starting with <!doctype html>. No explanations, no code fences.`;

async function coding(c: Ctx): Promise<Out> {
  const { text } = await llm({ system: CODER, maxTokens: 8000, timeoutMs: 240000, prefer: "fast", temperature: 0.4, strict: true, msgs: [{ role: "user", content: context(c) }] });
  const html = extractHtml(text);
  if (!html) return { output: "Coding Agent could not produce valid HTML. Raw start: " + text.slice(0, 300) };
  return { output: `Built ${Math.round(html.length / 1024)} KB HTML app.`, files: [{ name: `${slug(c.task.title)}.html`, mime: "text/html", content: html }] };
}
const extractHtml = (t: string) => { const s = t.replace(/```(html)?/gi, ""); const i = s.search(/<!doctype html|<html/i); const j = s.lastIndexOf("</html>");
  return i >= 0 && j > i ? s.slice(i, j + 7) : null; };

/** Static checks: structure + JS syntax of inline scripts (compiled, never executed). */
export function checkHtml(html: string): string[] {
  const errs: string[] = [];
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) errs.push("Missing <html> structure");
  if (!/<body[\s>]/i.test(html)) errs.push("Missing <body>");
  const scripts = [...html.matchAll(/<script((?![^>]*\bsrc=)[^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/type\s*=\s*["']?(module|application\/(ld\+)?json|text\/template)/i.test(m[1])).map((m) => m[2]);
  scripts.forEach((js, i) => { try { new Function(js); } catch (e) { errs.push(`Inline script #${i + 1}: ${(e as Error).message}`); } });
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/gi)) if (!/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)\//.test(m[1])) errs.push(`Untrusted script source: ${m[1]}`);
  if (/TODO|lorem ipsum/i.test(html)) errs.push("Contains placeholder text (TODO / lorem ipsum)");
  return errs;
}

async function testing(c: Ctx): Promise<Out> {
  const [f] = await sel("files", `task_id=eq.${c.task.id}&mime=eq.text%2Fhtml&order=created_at.desc&limit=1`);
  if (!f) return { output: "Nothing to test — no HTML file was built in this task." };
  let html = f.content as string, errs = checkHtml(html), log = [`Round 1: ${errs.length ? errs.join("; ") : "all checks passed"}`];
  for (let round = 2; errs.length && round <= 3; round++) {
    const { text } = await llm({ system: CODER, maxTokens: 8000, timeoutMs: 200000, prefer: "fast", temperature: 0.2, strict: true,
      msgs: [{ role: "user", content: `Fix these problems and return the full corrected HTML:\n- ${errs.join("\n- ")}\n\nHTML:\n${html.slice(0, 60000)}` }] });
    const fixed = extractHtml(text);
    if (!fixed) break;
    html = fixed; errs = checkHtml(html); log.push(`Round ${round} (after fix): ${errs.length ? errs.join("; ") : "all checks passed"}`);
  }
  await upd("files", `id=eq.${f.id}`, { content: html, size: html.length });
  const scripts = [...html.matchAll(/<script/gi)].length;
  return { output: `Tested ${f.name}: structure, ${scripts} script block(s) syntax-compiled, CDN sources, placeholders.\n${log.join("\n")}${errs.length ? "\n⚠ Remaining issues flagged." : "\n✅ Verified."}` };
}

const RUN: Record<string, (c: Ctx) => Promise<Out>> = {
  research, data, coding, testing, document,
  business: (c) => think(c, "Analyze opportunities, models, pricing (INR), positioning, customers and concrete next actions."),
  hr: (c) => think(c, "Apply Indian HR/payroll practice (PF, ESI, PT, TDS, labour codes) accurately; flag anything that needs a professional check."),
  communication: (c) => think(c, "Draft ready-to-send messages (subject lines where relevant), personalised per recipient from the context. These are drafts; the user sends them."),
  manual: async (c) => ({ output: "", waitUser: c.step.instruction || c.step.title }),
};

// ───────────────────────────── Tick ─────────────────────────────
export async function tick(): Promise<string> {
  if (!(await enabled())) return "paused";
  // 1) Plan any new task (atomic claim: planning → running)
  const [fresh] = await sel("tasks", "status=eq.planning&order=created_at.asc&limit=1");
  if (fresh) {
    const [claimed] = await upd("tasks", `id=eq.${fresh.id}&status=eq.planning`, { status: "running", phase: "Planning", updated_at: now() });
    if (claimed) {
      try { await planTask(claimed); return `planned ${claimed.id}`; }
      catch (e) { await upd("tasks", `id=eq.${claimed.id}`, { status: "failed", phase: "Needs attention", summary: `Planning failed: ${(e as Error).message}`, updated_at: now() }); return "plan failed"; }
    }
  }
  // 2) Run the next step of the oldest-updated running task
  const running = await sel("tasks", "status=eq.running&order=updated_at.asc&limit=5");
  for (const t of running) {
    const steps = await sel("steps", `task_id=eq.${t.id}&order=idx.asc`);
    if (!steps.length) { await upd("tasks", `id=eq.${t.id}`, { status: "planning" }); continue; } // re-plan
    const busy = steps.find((s) => s.status === "running");
    if (busy) {
      if (Date.now() - Date.parse(busy.started_at) < 6 * 60e3) continue; // someone else is on it
      await upd("steps", `id=eq.${busy.id}`, { status: busy.attempts >= 2 ? "failed" : "pending", output: "Timed out; retrying." });
      continue;
    }
    const next = steps.find((s) => s.status === "pending");
    if (!next) { await finalize(t, steps); return `finalized ${t.id}`; }
    const [claim] = await upd("steps", `id=eq.${next.id}&status=eq.pending`, { status: "running", started_at: now(), attempts: next.attempts + 1 });
    if (!claim) continue;
    await upd("tasks", `id=eq.${t.id}`, { phase: `${PHASE[next.agent]} · ${AGENT_LABEL[next.agent]}`, updated_at: now() });
    const prior = steps.filter((s) => s.status === "done" && s.output)
      .map((s) => `## ${s.title} (${AGENT_LABEL[s.agent]})\n${s.user_input ? `User provided: ${s.user_input}\n` : ""}${String(s.output).slice(0, 3500)}`).join("\n\n").slice(-12000);
    try {
      const [{ system }, lessons] = await Promise.all([persona(), sel("learnings", "active=eq.true&order=at.desc&limit=25").catch(() => [])]);
      const learn = lessons.map((l) => `- [${l.scope}] ${l.rule}`).join("\n");
      const out = await RUN[next.agent]({ task: t, step: next, prior, system, learn });
      if (out.waitUser) {
        await upd("steps", `id=eq.${next.id}`, { status: "waiting_user" });
        await upd("tasks", `id=eq.${t.id}`, { status: "waiting_user", phase: "Waiting for you", needs: out.waitUser, updated_at: now() });
        return `waiting ${t.id}`;
      }
      for (const f of out.files ?? []) { await ins("files", { task_id: t.id, ...f, size: f.content.length }); await audit("mission", "file", `${t.title} → ${f.name}`); }
      await upd("steps", `id=eq.${next.id}`, { status: "done", output: out.output, finished_at: now() });
      await upd("tasks", `id=eq.${t.id}`, { updated_at: now() });
      return `step ${next.id} done`;
    } catch (e) {
      const failed = next.attempts + 1 >= 3;
      await upd("steps", `id=eq.${next.id}`, { status: failed ? "failed" : "pending", output: `Error: ${(e as Error).message}` });
      if (failed) { await upd("tasks", `id=eq.${t.id}`, { status: "failed", phase: "Needs attention", summary: `${next.title} failed: ${(e as Error).message}`, updated_at: now() });
        await audit("mission", "mission_failed", `${t.title}: ${next.title} — ${(e as Error).message}`, "failed"); }
      return `step ${next.id} error`;
    }
  }
  return "idle";
}

async function finalize(t: Row, steps: Row[]) {
  const files = await sel("files", `task_id=eq.${t.id}&select=name`);
  const digest = steps.map((s) => `- ${s.title} [${s.status}]: ${String(s.output ?? "").slice(0, 400)}`).join("\n");
  const { text } = await llm({ system: "You are NOVA reporting to your Boss. 2-4 short sentences, warm and confident, Hinglish-friendly. Say what was done, key findings, what files are ready, and the ONE next action for the Boss (e.g., review & send drafts). Never claim you sent messages.",
    maxTokens: 900, timeoutMs: 60000, msgs: [{ role: "user", content: `Task: ${t.title}\nGoal: ${t.goal}\nSteps:\n${digest}\nFiles: ${files.map((f) => f.name).join(", ") || "none"}` }] });
  const anyFailed = steps.some((s) => s.status === "failed");
  await upd("tasks", `id=eq.${t.id}`, { status: anyFailed ? "failed" : "completed", phase: anyFailed ? "Needs attention" : "Completed", summary: text, needs: null, updated_at: now() });
  await ins("messages", { role: "assistant", content: `✅ ${t.title}: ${text}` }).catch(() => null);
  await audit("mission", anyFailed ? "mission_failed" : "mission_done", t.title, anyFailed ? "failed" : "done");
  if (!anyFailed) await nextMoves(t, digest).catch(() => null);
}

/** Proactive: after a mission, NOVA proposes the next 3 moves. With Autopilot on, she starts the top one herself (chains up to 2 deep). */
async function nextMoves(t: Row, digest: string) {
  const { text } = await llm({ system: "You are NOVA, an autonomous business operator for a solo HR/payroll founder in Gurugram. Output JSON only.", json: true, maxTokens: 700, prefer: "fast",
    msgs: [{ role: "user", content: `A mission just finished.\nTitle: ${t.title}\nGoal: ${t.goal}\nWhat was done:\n${digest.slice(0, 3500)}\n\n` +
      `Propose the next 3 missions that move the Boss closest to revenue, most valuable first. Each must be doable by NOVA's agents (research, analysis, data tables, drafts, documents, dashboards) — never sending, paying or logging in. ` +
      `JSON: {"moves":[{"title":"<6-10 words>","goal":"<full self-contained mission goal in English>","why":"<one line>"}]}` }] });
  const moves = parseJSON<{ moves?: { title: string; goal: string; why?: string }[] }>(text, {}).moves?.filter((m) => m?.goal).slice(0, 3) ?? [];
  if (!moves.length) return;
  const depth = Number(t.depth ?? 0);
  const rows = await ins("proposals", moves.map((m) => ({ kind: "next", title: m.title.slice(0, 90), body: m.why ?? "", payload: { goal: m.goal, from: t.id, depth: depth + 1 } })));
  if (depth < 2 && (await autopilot())) {
    const [first] = rows;
    await upd("proposals", `id=eq.${first.id}`, { status: "approved", reason: "Autopilot", decided_at: now() });
    await createTask(first.payload.goal, undefined, { source: "autopilot", depth: depth + 1 });
  }
}

export async function resume(taskId: number, input: string) {
  const [s] = await sel("steps", `task_id=eq.${taskId}&status=eq.waiting_user&limit=1`);
  if (s) await upd("steps", `id=eq.${s.id}`, { status: "done", user_input: input.slice(0, 2000) || "Done", output: `Boss completed: ${s.title}`, finished_at: now() });
  await upd("tasks", `id=eq.${taskId}&status=eq.waiting_user`, { status: "running", needs: null, phase: "Resuming", updated_at: now() });
}

export async function createTask(goal: string, attachment?: string, o: { source?: "chat" | "voice" | "autopilot" | "mission"; depth?: number } = {}) {
  if (!(await enabled())) { await audit(o.source ?? "chat", "mission_start", goal.slice(0, 200), "blocked"); throw new Error("NOVA is paused — press ⏻ Resume first."); }
  const [t] = await ins("tasks", { title: goal.slice(0, 90), goal: goal.slice(0, 4000), attachment: attachment?.slice(0, 60000) ?? null, depth: o.depth ?? 0 });
  await audit(o.source ?? "chat", "mission_start", goal.slice(0, 200));
  return t;
}
