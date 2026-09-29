// Phone → NOVA events (e.g. incoming call). Called by MacroDroid "HTTP Request"; authenticated by the per-user device key.
import { ins } from "@/lib/db";
import { setting } from "@/lib/phone";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url), key = await setting("device_key");
  if (!key || u.searchParams.get("key") !== key) return Response.json({ error: "unauthorized" }, { status: 401 });
  const clip = (k: string, n = 80) => (u.searchParams.get(k) ?? "").slice(0, n);
  await ins("device_events", { type: clip("type", 20) || "event", name: clip("name"), number: clip("number", 20), detail: clip("detail", 200) });
  return Response.json({ ok: true });
}
