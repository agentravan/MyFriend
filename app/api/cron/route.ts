// Vercel Cron (daily, Hobby tier). Vercel sends "Authorization: Bearer $CRON_SECRET".
import { NextResponse } from "next/server";
import { runDaily } from "@/lib/nova";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try { return NextResponse.json(await runDaily()); }
  catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 500 }); }
}
