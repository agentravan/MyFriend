// Phone Link: NOVA → your Android phone through a MacroDroid Webhook trigger (instant, via Firebase push).
// NOVA calls  https://trigger.macrodroid.com/<device-id>/nova?nova_action=call&nova_number=…  and one macro does the rest.
// Phone → NOVA: MacroDroid "HTTP Request" to /api/device/event?key=… announces incoming calls.
import { ins, sel } from "@/lib/db";

export const PHONE_OPS = ["call", "sms", "answer", "end_call", "speaker_on", "torch_on", "torch_off", "silent", "vibrate", "ring", "find_phone"] as const;
export type PhoneOp = (typeof PHONE_OPS)[number];

export async function setting(key: string) { return (await sel("settings", `key=eq.${key}&limit=1`))[0]?.value as string | undefined; }
export async function setSetting(key: string, value: string) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/settings?on_conflict=key`, { method: "POST", cache: "no-store",
    headers: { apikey: process.env.SUPABASE_ANON_KEY!, ...(process.env.SUPABASE_ANON_KEY?.startsWith("eyJ") && { Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}` }),
      "x-nova-key": process.env.NOVA_DB_SECRET!, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });
}

export async function linkPhone(url: string) {
  const u = url.trim();
  if (!/^https:\/\/trigger\.macrodroid\.com\/[\w-]+\/[\w-]+\/?$/.test(u)) throw new Error("Paste the MacroDroid webhook URL, like https://trigger.macrodroid.com/<device-id>/nova");
  await setSetting("phone_webhook", u.replace(/\/$/, ""));
  if (!(await setting("device_key"))) await setSetting("device_key", crypto.randomUUID().replace(/-/g, ""));
}

export async function phone(op: PhoneOp, p: { number?: string; text?: string; name?: string } = {}) {
  const base = await setting("phone_webhook");
  if (!base) throw new Error("Phone Link not set up yet — open Settings → Phone Link.");
  if (!(PHONE_OPS as readonly string[]).includes(op)) throw new Error("Unsupported phone action");
  const num = (p.number ?? "").replace(/[^\d+]/g, "");
  const q = new URLSearchParams({ nova_action: op, nova_number: num, nova_text: (p.text ?? "").slice(0, 900), nova_name: p.name ?? "" });
  const r = await fetch(`${base}?${q}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`Phone didn't accept the command (${r.status})`);
  await ins("actions", { kind: `phone:${op}`, payload: { ...p, number: num } }).catch(() => null);
  return true;
}
