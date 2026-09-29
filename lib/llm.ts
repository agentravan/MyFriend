// LLM router: Groq (primary) -> Gemini (fallback). Private context (memory, ledger) goes to Groq only.
export type Msg = { role: "user" | "assistant"; content: string };
type Opts = { system: string; privateCtx?: string; msgs: Msg[]; json?: boolean; maxTokens?: number };

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

async function groq({ system, privateCtx, msgs, json, maxTokens = 600 }: Opts) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL, temperature: 0.6, max_tokens: maxTokens,
      ...(json && { response_format: { type: "json_object" } }),
      messages: [{ role: "system", content: system + (privateCtx ? "\n\n" + privateCtx : "") }, ...msgs],
    }),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  return (await r.json()).choices[0].message.content as string;
}

async function gemini({ system, msgs, json, maxTokens = 600 }: Opts) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] }, // privateCtx deliberately NOT sent
        contents: msgs.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens, ...(json && { responseMimeType: "application/json" }) },
      }),
    }
  );
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  return (await r.json()).candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
}

export async function llm(o: Opts): Promise<{ text: string; provider: string }> {
  const errs: string[] = [];
  if (process.env.GROQ_API_KEY) try { return { text: await groq(o), provider: "groq" }; } catch (e) { errs.push(String(e)); }
  if (process.env.GEMINI_API_KEY) try { return { text: await gemini(o), provider: "gemini" }; } catch (e) { errs.push(String(e)); }
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY)
    return { text: "Mera brain abhi offline hai — Vercel settings mein GROQ_API_KEY (free, console.groq.com) add karo, phir redeploy.", provider: "none" };
  return { text: `Brain providers busy hain (${errs.join(", ")}). Thodi der mein try karo.`, provider: "error" };
}

export function parseJSON<T>(s: string, fallback: T): T {
  try { return JSON.parse(s.replace(/^```(json)?|```$/g, "").trim()) as T; } catch { return fallback; }
}
