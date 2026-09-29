// LLM router: NVIDIA NIM → Groq → Gemini (first one with a key that answers wins).
// Private context (memory, ledger, contacts) goes to NVIDIA/Groq only — never to Gemini's free tier.
export type Msg = { role: "user" | "assistant"; content: string };
type Opts = { system: string; privateCtx?: string; msgs: Msg[]; json?: boolean; maxTokens?: number; temperature?: number };

const OPENAI_COMPAT = [
  { name: "nvidia", url: "https://integrate.api.nvidia.com/v1/chat/completions", key: () => process.env.NVIDIA_API_KEY,
    model: () => process.env.NVIDIA_MODEL || "meta/llama-3.3-70b-instruct", jsonMode: false },
  { name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: () => process.env.GROQ_API_KEY,
    model: () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile", jsonMode: true },
];

async function openaiCompat(p: (typeof OPENAI_COMPAT)[number], o: Opts) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 25000);
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
    if (!r.ok) throw new Error(`${p.name} ${r.status}`);
    return (await r.json()).choices[0].message.content as string;
  } finally { clearTimeout(t); }
}

async function gemini(o: Opts) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: o.system }] }, // privateCtx deliberately NOT sent
      contents: o.msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: o.maxTokens ?? 700, ...(o.json && { responseMimeType: "application/json" }) },
    }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  return (await r.json()).candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
}

export async function llm(o: Opts): Promise<{ text: string; provider: string }> {
  const errs: string[] = [];
  for (const p of OPENAI_COMPAT) {
    if (!p.key()) continue;
    try { return { text: await openaiCompat(p, o), provider: p.name }; } catch (e) { errs.push(String((e as Error).message)); }
  }
  if (process.env.GEMINI_API_KEY) try { return { text: await gemini(o), provider: "gemini" }; } catch (e) { errs.push(String(e)); }
  if (!errs.length)
    return { text: "Mera brain offline hai — Vercel settings mein NVIDIA_API_KEY ya GROQ_API_KEY add karo, phir redeploy.", provider: "none" };
  return { text: `Brain providers busy hain (${errs.join(", ")}). Thodi der mein try karo.`, provider: "error" };
}

export const providers = () =>
  [...OPENAI_COMPAT.filter((p) => p.key()).map((p) => p.name), ...(process.env.GEMINI_API_KEY ? ["gemini"] : [])];

/** Tolerant JSON extraction: handles ```json fences and chatter around the object. */
export function parseJSON<T>(s: string, fallback: T): T {
  const clean = s.replace(/```(json)?/gi, "").trim();
  for (const cand of [clean, clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)]) {
    try { return JSON.parse(cand) as T; } catch { /* try next */ }
  }
  return fallback;
}
