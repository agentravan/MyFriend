// Background worker endpoint, called every minute by Supabase pg_cron while tasks are active.
import { NextResponse } from "next/server";
import { tick } from "@/lib/agents";
import { health, probe, speakNeural } from "@/lib/llm";
import { searchEngine, search } from "@/lib/web";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  if (u.searchParams.has("tts")) { try { const w = await speakNeural("Good evening Boss. This is NOVA."); return NextResponse.json({ ttsBytes: w.length }); } catch (e) { return NextResponse.json({ ttsError: (e as Error).message }); } }
  if (u.searchParams.has("probe")) return NextResponse.json(await probe(u.searchParams.get("probe")!));
  if (u.searchParams.has("health")) { // diagnostics for the operator (secret-protected)
    const hits = await search("payroll software India pricing", 3).catch(() => []);
    return NextResponse.json({ health: await health(), search: searchEngine(), sample: hits.map((h) => h.title) });
  }
  try { return NextResponse.json({ tick: await tick() }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}
