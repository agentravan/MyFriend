// Web tools for the Research Agent: search (Tavily/Brave if keyed, else DuckDuckGo HTML) + page reader (Jina, else raw).
import { env } from "@/lib/llm";

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

async function ddg(q: string, n: number): Promise<Hit[]> {
  const r = await fetch("https://html.duckduckgo.com/html/", { method: "POST", signal: withTimeout(15000),
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: `q=${encodeURIComponent(q)}&kl=in-en` });
  if (!r.ok) throw new Error(`ddg ${r.status}`);
  const html = await r.text(), hits: Hit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && hits.length < n) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (/duckduckgo\.com\/y\.js|ad_provider/.test(url)) continue; // skip ads
    hits.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
  }
  return hits;
}

export async function search(q: string, n = 6): Promise<Hit[]> {
  const engines = [env("TAVILY_API_KEY") && tavily, env("BRAVE_API_KEY") && brave, ddg].filter(Boolean) as ((q: string, n: number) => Promise<Hit[]>)[];
  for (const e of engines) { try { const h = await e(q, n); if (h.length) return h; } catch { /* next engine */ } }
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

export const searchEngine = () => (env("TAVILY_API_KEY") ? "tavily" : env("BRAVE_API_KEY") ? "brave" : "duckduckgo");
