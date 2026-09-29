// LLM router: NVIDIA NIM → Groq → Gemini (first one with a key that answers wins).
// Private context (memory, ledger, contacts) goes to NVIDIA/Groq only — never to Gemini's free tier.
export type Msg = { role: "user" | "assistant"; content: string };
type Opts = { system: string; privateCtx?: string; msgs: Msg[]; json?: boolean; maxTokens?: number; temperature?: number;
  timeoutMs?: number; prefer?: "fast" };
// Providers whose key was rejected are skipped for 10 min (per warm instance) to avoid paying the latency every call.
const dead = new Map<string, number>();

/** First non-empty env var among aliases, trimmed (pasted keys often carry spaces/newlines/quotes). */
export const env = (...names: string[]) => {
  for (const n of names) { const v = process.env[n]?.trim().replace(/^["']|["']$/g, ""); if (v) return v; }
  return undefined;
};
const NVIDIA_KEY = () => env("NVIDIA_API_KEY", "NVIDIA_AI", "NVIDIA_KEY", "NVIDIA");
const GROQ_KEY = () => env("GROQ_API_KEY", "GROQ", "GROQ_KEY");
const GEMINI_KEY = () => env("GEMINI_API_KEY", "Gemini", "GEMINI", "GEMINI_KEY", "GOOGLE_API_KEY");

const OPENAI_COMPAT = [
  { name: "nvidia", url: "https://integrate.api.nvidia.com/v1/chat/completions", key: NVIDIA_KEY,
    model: () => process.env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct", jsonMode: false },
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: GROQ_KEY,
    model: () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile", jsonMode: true },
];

async function openaiCompat(p: (typeof OPENAI_COMPAT)[number], o: Opts) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), o.timeoutMs ?? 25000);
  try {
    const r = await fetch(p.url, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${p.key()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: p.model(), temperature: o.temperature ?? 0.5, max_tokens: o.maxTokens ?? 700,
        ...(o.json && p.jsonMode && { response_format: { type: "json_object" } }),
        messages: [{ role: "system", content: o.system + (o.privateCtx ? "\n\n" + o.privateCtx : "") }, ...o.msgs],
      }),
    });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `${p.name}: key rejected (${r.status}) — check the key in Vercel` : `${p.name} ${r.status}`);
    return (await r.json()).choices[0].message.content as string;
  } finally { clearTimeout(t); }
}

async function gemini(o: Opts) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_KEY()!, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: o.system }] }, // privateCtx deliberately NOT sent
      contents: o.msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: o.maxTokens ?? 700, ...(o.json && { responseMimeType: "application/json" }) },
    }),
  });
  if (!r.ok) throw new Error(r.status === 400 || r.status === 403 ? `gemini: key rejected (${r.status})` : `gemini ${r.status}`);
  return (await r.json()).candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
}

export async function llm(o: Opts): Promise<{ text: string; provider: string }> {
  const errs: string[] = [];
  const order = o.prefer === "fast" ? [...OPENAI_COMPAT].reverse() : OPENAI_COMPAT; // Groq first for long generations
  for (const p of order) {
    if (!p.key() || (dead.get(p.name) ?? 0) > Date.now()) continue;
    try { return { text: await openaiCompat(p, o), provider: p.name }; }
    catch (e) { const m = String((e as Error).message); errs.push(m); if (m.includes("rejected")) dead.set(p.name, Date.now() + 600e3); }
  }
  if (GEMINI_KEY()) try { return { text: await gemini(o), provider: "gemini" }; } catch (e) { errs.push(String(e)); }
  if (!errs.length)
    return { text: "Mera brain offline hai — Vercel settings mein NVIDIA_API_KEY ya GROQ_API_KEY add karo, phir redeploy.", provider: "none" };
  return { text: `Brain error: ${errs.join(" · ")}. Keys fix karo ya thodi der mein try karo.`, provider: "error" };
}

export const providers = () =>
  [...OPENAI_COMPAT.filter((p) => p.key()).map((p) => p.name), ...(GEMINI_KEY() ? ["gemini"] : [])];

/** Probe each configured provider with a 1-token call so the UI can show which keys actually work. */
export async function health() {
  const out: Record<string, string> = {};
  await Promise.all([
    ...OPENAI_COMPAT.filter((p) => p.key()).map(async (p) => {
      try { await openaiCompat(p, { system: "ping", msgs: [{ role: "user", content: "hi" }], maxTokens: 1 }); out[p.name] = "ok"; }
      catch (e) { out[p.name] = (e as Error).message; }
    }),
    ...(GEMINI_KEY() ? [gemini({ system: "ping", msgs: [{ role: "user", content: "hi" }], maxTokens: 1 }).then(() => { out.gemini = "ok"; }).catch((e) => { out.gemini = (e as Error).message; })] : []),
  ]);
  return out;
}

/** Tolerant JSON extraction: handles ```json fences and chatter around the object. */
export function parseJSON<T>(s: string, fallback: T): T {
  const clean = s.replace(/```(json)?/gi, "").trim();
  for (const cand of [clean, clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)]) {
    try { return JSON.parse(cand) as T; } catch { /* try next */ }
  }
  return fallback;
}
