// LLM router: NVIDIA NIM → Groq → Gemini. Models are auto-discovered, so retired model names never break NOVA.
// Private context (memory, ledger, contacts) goes to NVIDIA/Groq only — never to Gemini's free tier.
export type Msg = { role: "user" | "assistant"; content: string };
type Opts = { system: string; privateCtx?: string; msgs: Msg[]; json?: boolean; maxTokens?: number; temperature?: number;
  timeoutMs?: number; prefer?: "fast"; strict?: boolean };

/** First non-empty env var among aliases, trimmed (pasted keys often carry spaces/newlines/quotes). */
export const env = (...names: string[]) => {
  for (const n of names) { const v = process.env[n]?.trim().replace(/^["']|["']$/g, ""); if (v) return v; }
  return undefined;
};
const NVIDIA_KEY = () => env("NVIDIA_API_KEY", "NVIDIA_AI", "NVIDIA_KEY", "NVIDIA");
const GROQ_KEY = () => env("GROQ_API_KEY", "GROQ", "GROQ_KEY");
export const GEMINI_KEY = () => env("GEMINI_API_KEY", "Gemini", "GEMINI", "GEMINI_KEY", "GOOGLE_API_KEY");

type P = { name: string; base: string; key: () => string | undefined; override?: string; prefer: string[]; jsonMode: boolean };
const OPENAI_COMPAT: P[] = [
  { name: "nvidia", base: "https://integrate.api.nvidia.com/v1", key: NVIDIA_KEY, override: "NVIDIA_MODEL", jsonMode: false,
    prefer: ["deepseek-ai/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "moonshotai/kimi-k2.6", "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/llama-3.1-nemotron-70b-instruct", "mistralai/mistral-large-2-instruct", "openai/gpt-oss-20b", "meta/llama-3.3-70b-instruct"] },
  { name: "groq", base: "https://api.groq.com/openai/v1", key: GROQ_KEY, override: "GROQ_MODEL", jsonMode: true,
    prefer: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct", "qwen/qwen3-32b", "llama-3.1-8b-instant"] },
];

// Per warm instance caches
const dead = new Map<string, number>();       // provider → skip-until (key rejected)
const chosen = new Map<string, string>();     // provider → working model
const badModels = new Set<string>();          // "provider:model" that 404/410'd
const lists = new Map<string, string[]>();

async function listModels(p: P): Promise<string[]> {
  if (lists.has(p.name)) return lists.get(p.name)!;
  try {
    const r = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key()}` }, signal: AbortSignal.timeout(8000) });
    const ids: string[] = r.ok ? ((await r.json()).data ?? []).map((m: { id: string }) => m.id) : [];
    lists.set(p.name, ids); return ids;
  } catch { return []; }
}
async function pickModel(p: P): Promise<string | undefined> {
  if (chosen.has(p.name)) return chosen.get(p.name);
  const ids = await listModels(p), ok = (m?: string) => !!m && !badModels.has(`${p.name}:${m}`) && (!ids.length || ids.includes(m));
  const m = [process.env[p.override ?? ""], ...p.prefer].find(ok)
    ?? ids.find((i) => !badModels.has(`${p.name}:${i}`) && /instruct|chat|versatile|flash|gpt-oss|kimi|glm/i.test(i) && !/embed|guard|safety|reward|whisper|tts|vision|parse|retriev/i.test(i));
  if (m) chosen.set(p.name, m);
  return m;
}
const clean = (t: string) => t.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

async function openaiCompat(p: P, o: Opts) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const model = await pickModel(p);
    if (!model) throw new Error(`${p.name}: no usable model`);
    const r = await fetch(`${p.base}/chat/completions`, {
      method: "POST", signal: AbortSignal.timeout(o.timeoutMs ?? 25000),
      headers: { Authorization: `Bearer ${p.key()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, temperature: o.temperature ?? 0.5, max_tokens: o.maxTokens ?? 700,
        ...(o.json && p.jsonMode && { response_format: { type: "json_object" } }),
        messages: [{ role: "system", content: o.system + (o.privateCtx ? "\n\n" + o.privateCtx : "") }, ...o.msgs],
      }),
    });
    if (r.ok) { const j = await r.json(); return clean(j.choices?.[0]?.message?.content ?? ""); }
    const body = await r.text().catch(() => "");
    if (r.status === 401 || r.status === 403) throw new Error(`${p.name}: key rejected (${r.status}) — check the key in Vercel`);
    if (r.status === 404 || r.status === 410 || ((r.status === 400 || r.status === 422) && /model/i.test(body))) {
      badModels.add(`${p.name}:${model}`); chosen.delete(p.name); continue; // retired model → try the next one
    }
    throw new Error(`${p.name} ${r.status}`);
  }
  throw new Error(`${p.name}: models unavailable`);
}

let geminiModel: string | undefined;
async function pickGemini() {
  if (geminiModel) return geminiModel;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": GEMINI_KEY()! }, signal: AbortSignal.timeout(8000) });
    const ms: { name: string; supportedGenerationMethods?: string[] }[] = r.ok ? (await r.json()).models ?? [] : [];
    const gen = ms.filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => m.name.replace("models/", ""));
    const ver = (s: string) => parseFloat(s.match(/gemini-(\d+(\.\d+)?)/)?.[1] ?? "0");
    const pick = (re: RegExp) => gen.filter((n) => re.test(n) && !/preview|exp|thinking|image|tts|live|lite/i.test(n)).sort((a, b) => ver(b) - ver(a))[0];
    geminiModel = process.env.GEMINI_MODEL || pick(/^gemini-[\d.]+-flash$/) || pick(/flash/) || pick(/pro/) || gen.find((n) => n.startsWith("gemini")) || "gemini-flash-latest";
  } catch { geminiModel = process.env.GEMINI_MODEL || "gemini-flash-latest"; }
  return geminiModel;
}

async function gemini(o: Opts & { tools?: object[] }): Promise<{ text: string; raw: Record<string, unknown> }> {
  const model = await pickGemini();
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", signal: AbortSignal.timeout(o.timeoutMs ?? 30000),
    headers: { "x-goog-api-key": GEMINI_KEY()!, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: o.system }] }, // privateCtx deliberately NOT sent
      contents: o.msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      ...(o.tools && { tools: o.tools }),
      generationConfig: { maxOutputTokens: o.maxTokens ?? 700, ...(o.json && !o.tools && { responseMimeType: "application/json" }) },
    }),
  });
  if (!r.ok) {
    if (r.status === 404) geminiModel = undefined;
    throw new Error(r.status === 400 || r.status === 403 ? `gemini: key rejected (${r.status})` : `gemini ${r.status}`);
  }
  const j = await r.json();
  return { text: clean(j.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? ""), raw: j };
}
export { gemini as geminiRaw };

export async function llm(o: Opts): Promise<{ text: string; provider: string }> {
  const errs: string[] = [];
  const order = o.prefer === "fast" ? [...OPENAI_COMPAT].reverse() : OPENAI_COMPAT; // Groq first for long generations
  for (const p of order) {
    if (!p.key() || (dead.get(p.name) ?? 0) > Date.now()) continue;
    try { return { text: await openaiCompat(p, o), provider: p.name }; }
    catch (e) { const m = String((e as Error).message); errs.push(m); if (m.includes("rejected")) dead.set(p.name, Date.now() + 600e3); }
  }
  if (GEMINI_KEY() && (dead.get("gemini") ?? 0) < Date.now()) {
    try { return { text: (await gemini(o)).text, provider: "gemini" }; }
    catch (e) { const m = String((e as Error).message); errs.push(m); if (m.includes("rejected")) dead.set("gemini", Date.now() + 600e3); }
  }
  const msg = !errs.length ? "No AI key configured — add NVIDIA_API_KEY or GROQ_API_KEY in Vercel, then redeploy." : `Brain error: ${errs.join(" · ")}`;
  if (o.strict) throw new Error(msg);
  return { text: errs.length ? `${msg}. Keys fix karo ya thodi der mein try karo.` : "Mera brain offline hai — " + msg, provider: errs.length ? "error" : "none" };
}

export const providers = () => [...OPENAI_COMPAT.filter((p) => p.key()).map((p) => p.name), ...(GEMINI_KEY() ? ["gemini"] : [])];

/** Probe each configured provider with a tiny call so the UI can show which keys actually work (and which model). */
export async function health() {
  const out: Record<string, string> = {};
  const ping = { system: "Reply with OK.", msgs: [{ role: "user" as const, content: "ping" }], maxTokens: 5, timeoutMs: 20000 };
  await Promise.all([
    ...OPENAI_COMPAT.filter((p) => p.key()).map(async (p) => {
      try { await openaiCompat(p, ping); out[p.name] = "ok"; out[`${p.name}_model`] = chosen.get(p.name) ?? ""; }
      catch (e) { out[p.name] = (e as Error).message; }
    }),
    ...(GEMINI_KEY() ? [gemini(ping).then(() => { out.gemini = "ok"; out.gemini_model = geminiModel ?? ""; }).catch((e) => { out.gemini = (e as Error).message; })] : []),
  ]);
  return out;
}

/** Operator diagnostics: time a tiny call against each candidate model of a provider. */
export async function probe(name: string) {
  const out: Record<string, string> = {};
  if (name === "gemini") {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": GEMINI_KEY() ?? "" } });
    const ms: { name: string; supportedGenerationMethods?: string[] }[] = r.ok ? (await r.json()).models ?? [] : [];
    const names = ms.filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => m.name.replace("models/", "")).filter((n) => /flash|pro/.test(n) && !/image|tts|live|embed/.test(n)).slice(0, 10);
    await Promise.all(names.map(async (m) => { const t = Date.now();
      const x = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", signal: AbortSignal.timeout(30000),
        headers: { "x-goog-api-key": GEMINI_KEY()!, "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Say OK" }] }], generationConfig: { maxOutputTokens: 5 } }) }).catch((e) => ({ status: String(e) }));
      out[m] = `${(x as Response).status} ${Date.now() - t}ms`; }));
    return out;
  }
  const p = OPENAI_COMPAT.find((x) => x.name === name)!;
  if (!p?.key()) return { error: "no key" };
  const ids = await listModels(p);
  await Promise.all(p.prefer.filter((m) => !ids.length || ids.includes(m)).map(async (m) => { const t = Date.now();
    const x = await fetch(`${p.base}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(45000), headers: { Authorization: `Bearer ${p.key()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, max_tokens: 5, messages: [{ role: "user", content: "Say OK" }] }) }).catch((e) => ({ status: String(e) }));
    out[m] = `${(x as Response).status} ${Date.now() - t}ms`; }));
  return out;
}

/** Tolerant JSON extraction: handles ```json fences and chatter around the object. */
export function parseJSON<T>(s: string, fallback: T): T {
  const c = s.replace(/```(json)?/gi, "").trim();
  for (const cand of [c, c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1)]) {
    try { return JSON.parse(cand) as T; } catch { /* try next */ }
  }
  return fallback;
}
