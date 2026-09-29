// Neural voice for NOVA (Gemini TTS). Passphrase-protected via middleware. Client falls back to the device voice on error.
import { speakNeural } from "@/lib/llm";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { text, voice } = await req.json();
    const audio = await speakNeural(String(text ?? "").trim(), String(voice ?? "Kore"));
    return new Response(new Uint8Array(audio), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
