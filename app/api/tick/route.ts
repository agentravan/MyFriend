// Background worker endpoint, called every minute by Supabase pg_cron while tasks are active.
import { NextResponse } from "next/server";
import { tick } from "@/lib/agents";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json({ tick: await tick() }); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}
