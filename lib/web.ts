// Web tools for the Research Agent: search (Tavily/Brave if keyed, else DuckDuckGo HTML) + page reader (Jina, else raw).
import { env, GEMINI_KEY, geminiRaw } from "@/lib/llm";

export type Hit = { title: string; url: string; snippet: string };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const withTimeout = (ms: number) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };
const strip = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

async function tavily(q: string, n: number): Promise<Hit[]> {
  const r = await fetch("https://api.tavily.com/search", { method: "POST", signal: withTimeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: env("TAVILY_API_KEY"), query: q, max_results: n }) });
  if (!r.ok) throw new Error(`tavily ${r.status}`);
  return ((await r.json()).results ?? []).map((x: { title: string; url: string; content: string }) => ({ title: x.title, url: x.url, snippet: x.content?.slice(0, 300) ?? "" }));
}

async function brave(q: string, n: number): Promise<Hit[]> {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, {
    signal: withTimeout(15000), headers: { "X-Subscription-Token": env("BRAVE_API_KEY")!, Accept: "application/json" } });
  if (!r.ok) throw new Error(`brave ${r.status}`);
  return ((await r.json()).web?.results ?? []).map((x: { title: string; url: string; description: string }) => ({ title: strip(x.title), url: x.url, snippet: strip(x.description ?? "") }));
}

async function serper(q: string, n: number): Promise<Hit[]> {
  const r = await fetch("https://google.serper.dev/search", { method: "POST", signal: withTimeout(15000),
    headers: { "X-API-KEY": env("SERPER_API_KEY")!, "Content-Type": "application/json" }, body: JSON.stringify({ q, gl: "in", num: n }) });
  if (!r.ok) throw new Error(`serper ${r.status}`);
  return ((await r.json()).organic ?? []).map((x: { title: string; link: string; snippet: string }) => ({ title: x.title, url: x.link, snippet: x.snippet ?? "" }));
}

/** Google Search grounding through the user's free Gemini key: real Google results + a grounded summary. */
async function googleViaGemini(q: string, n: number): Promise<Hit[]> {
  const { text, raw } = await geminiRaw({ system: "Answer factually using Google Search. Be concise; list concrete names, prices and facts.", tools: [{ google_search: {} }],
    msgs: [{ role: "user", content: q }], maxTokens: 900, timeoutMs: 40000 });
  const cand = (raw.candidates as { groundingMetadata?: { groundingChunks?: { web?: { uri: string; title: string } }[] } }[] | undefined)?.[0];
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  const hits: Hit[] = chunks.filter((c) => c.web?.uri).slice(0, n).map((c) => ({ title: c.web!.title, url: c.web!.uri, snippet: "" }));
  if (text) hits.unshift({ title: `Google-grounded answer for “${q}”`, url: "", snippet: text.slice(0, 2500) });
  return hits;
}

async function wikipedia(q: string, n: number): Promise<Hit[]> {
  const short = q.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(best|top|list|india|indian|price|pricing|cost|2023|2024|2025|2026)$/i.test(w)).slice(0, 4).join(" ") || q;
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${n}&srsearch=${encodeURIComponent(short)}`,
    { signal: withTimeout(10000), headers: { "User-Agent": "NOVA-personal-assistant/1.0" } });
  if (!r.ok) throw new Error(`wikipedia ${r.status}`);
  return ((await r.json()).query?.search ?? []).map((x: { title: string; snippet: string }) =>
    ({ title: x.title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, "_"))}`, snippet: strip(x.snippet) }));
}

const ENGINES: [string, () => string | undefined, (q: string, n: number) => Promise<Hit[]>][] = [
  ["tavily", () => env("TAVILY_API_KEY"), tavily], ["serper", () => env("SERPER_API_KEY"), serper], ["brave", () => env("BRAVE_API_KEY"), brave],
  ["google (via Gemini)", GEMINI_KEY, googleViaGemini], ["wikipedia", () => "always", wikipedia],
];

export async function search(q: string, n = 6): Promise<Hit[]> {
  for (const [, has, fn] of ENGINES) {
    if (!has()) continue;
    try { const h = await fn(q, n); if (h.length) return h; } catch { /* next engine */ }
  }
  return [];
}

/** Read a page as compact text (max ~6k chars). */
export async function read(url: string, max = 6000): Promise<string> {
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, { signal: withTimeout(15000), headers: { Accept: "text/plain", "X-Return-Format": "text" } });
    if (r.ok) { const t = (await r.text()).trim(); if (t.length > 200) return t.slice(0, max); }
  } catch { /* fall through */ }
  try {
    const r = await fetch(url, { signal: withTimeout(12000), headers: { "User-Agent": UA } });
    const h = await r.text();
    return strip(h.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")).slice(0, max);
  } catch { return ""; }
}

export const searchEngine = () => ENGINES.find(([, has]) => has())![0];
