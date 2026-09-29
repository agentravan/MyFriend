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
    // Probed 2026-09-29 on the user's key: nemotron-3-super 200 in 0.4s; kimi/llama/mistral 404; deepseek/glm/gpt-oss timed out.
    prefer: ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-nano-3-30b-a3b",
      "nvidia/llama-3.1-nemotron-ultra-253b-v1", "deepseek-ai/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "moonshotai/kimi-k2.6"] },
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
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await new Promise((w) => setTimeout(w, 1500)); continue; } // busy → brief retry
    throw new Error(`${p.name} ${r.status}`);
  }
  throw new Error(`${p.name}: models unavailable`);
}

let geminiModel: string | undefined;
const badGemini = new Set<string>();
async function pickGemini() {
  if (geminiModel) return geminiModel;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": GEMINI_KEY()! }, signal: AbortSignal.timeout(8000) });
    const ms: { name: string; supportedGenerationMethods?: string[] }[] = r.ok ? (await r.json()).models ?? [] : [];
    const gen = ms.filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => m.name.replace("models/", ""));
    const ver = (s: string) => parseFloat(s.match(/gemini-(\d+(\.\d+)?)/)?.[1] ?? "0");
    const ok = (n: string) => gen.includes(n) && !badGemini.has(n);
    // Probed 2026-09-29: gemini-3-flash-preview 200 in ~1s; 2.5 models 404; pro models 429 on free tier; flash-latest 22s.
    const PREF = [process.env.GEMINI_MODEL ?? "", "gemini-3-flash-preview", "gemini-3.1-flash-lite-preview", "gemini-flash-lite-latest", "gemini-flash-latest"];
    const pick = (re: RegExp) => gen.filter((n) => re.test(n) && !badGemini.has(n) && !/exp|thinking|image|tts|live|embed/i.test(n)).sort((a, b) => ver(b) - ver(a))[0];
    geminiModel = PREF.find(ok) || pick(/flash/) || pick(/pro/) || "gemini-flash-latest";
  } catch { geminiModel = process.env.GEMINI_MODEL || "gemini-flash-latest"; }
  return geminiModel;
}

async function gemini(o: Opts & { tools?: object[] }, retry = true): Promise<{ text: string; raw: Record<string, unknown> }> {
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
    if (r.status === 404 || r.status === 429) { badGemini.add(model); geminiModel = undefined; }
    if (retry && (r.status >= 500 || r.status === 404 || r.status === 429)) { await new Promise((w) => setTimeout(w, 1200)); return gemini(o, false); }
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

// ───────────── Neural voice (Gemini TTS) ─────────────
let ttsModel: string | undefined;
export const TTS_VOICES = ["Kore", "Aoede", "Despina", "Leda", "Zephyr", "Charon"] as const;
async function pickTTS() {
  if (ttsModel) return ttsModel;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { headers: { "x-goog-api-key": GEMINI_KEY()! }, signal: AbortSignal.timeout(8000) });
  const names: string[] = r.ok ? ((await r.json()).models ?? []).map((m: { name: string }) => m.name.replace("models/", "")).filter((n: string) => /tts/i.test(n)) : [];
  ttsModel = process.env.GEMINI_TTS_MODEL || names.find((n) => /flash/.test(n)) || names[0];
  return ttsModel;
}
const wav = (pcm: Buffer, rate = 24000) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
};
/** Returns a WAV file of NOVA speaking `text` (warm, confident female assistant; Hinglish-friendly). */
export async function speakNeural(text: string, voice = "Kore"): Promise<Buffer> {
  if (!GEMINI_KEY()) throw new Error("no gemini key");
  const model = await pickTTS();
  if (!model) throw new Error("no TTS model available");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", signal: AbortSignal.timeout(25000), headers: { "x-goog-api-key": GEMINI_KEY()!, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Say in a warm, calm, confident voice like a futuristic personal AI assistant (Indian English / Hinglish accent): ${text.slice(0, 900)}` }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: (TTS_VOICES as readonly string[]).includes(voice) ? voice : "Kore" } } } },
    }),
  });
  if (!r.ok) { if (r.status === 404) ttsModel = undefined; throw new Error(`tts ${r.status}`); }
  const part = (await r.json()).candidates?.[0]?.content?.parts?.find((p: { inlineData?: { data: string; mimeType: string } }) => p.inlineData);
  if (!part) throw new Error("tts: no audio");
  const rate = Number(part.inlineData.mimeType.match(/rate=(\d+)/)?.[1] ?? 24000);
  return wav(Buffer.from(part.inlineData.data, "base64"), rate);
}

/** Operator diagnostics: how a model returns reasoning under different "thinking off" switches. */
export async function probeThinking(model = "nvidia/nemotron-3-super-120b-a12b") {
  const p = OPENAI_COMPAT[0], out: Record<string, unknown> = {};
  const variants: [string, object, string][] = [
    ["default", {}, "You are helpful."],
    ["kwargs_enable_thinking_false", { chat_template_kwargs: { enable_thinking: false } }, "You are helpful."],
    ["kwargs_thinking_false", { chat_template_kwargs: { thinking: false } }, "You are helpful."],
    ["system_no_think", {}, "/no_think You are helpful."],
    ["reasoning_effort_low", { reasoning_effort: "low" }, "You are helpful."],
  ];
  await Promise.all(variants.map(async ([k, extra, sys]) => { const t = Date.now();
    try {
      const r = await fetch(`${p.base}/chat/completions`, { method: "POST", signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${p.key()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: "system", content: sys }, { role: "user", content: "List 3 Indian cities as a markdown table with one column. Only the table." }], ...extra }) });
      const j = await r.json(); const m = j.choices?.[0]?.message ?? {};
      out[k] = { status: r.status, ms: Date.now() - t, keys: Object.keys(m), content: String(m.content ?? j.error?.message ?? JSON.stringify(j).slice(0, 200)).slice(0, 260), reasoning: String(m.reasoning_content ?? m.reasoning ?? "").slice(0, 80) };
    } catch (e) { out[k] = String(e); } }));
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
