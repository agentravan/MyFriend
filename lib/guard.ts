// Safety core: one master switch every action path checks, plus an append-only activity log (DB allows insert/select only).
import { ins, sel } from "@/lib/db";

let cache: { at: number; on: boolean; auto: boolean } | null = null;

async function flags() {
  if (cache && Date.now() - cache.at < 5000) return cache;
  const rows = await sel("settings", "key=in.(nova_enabled,autopilot)").catch(() => []);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = { at: Date.now(), on: m.nova_enabled !== "off", auto: m.autopilot === "on" };
  return cache;
}
export const resetFlags = () => { cache = null; };
export const enabled = async () => (await flags()).on;
export const autopilot = async () => (await flags()).auto;

export class Paused extends Error { constructor() { super("NOVA is paused — press ⏻ Resume to let her act again."); } }
export async function assertOn() { if (!(await enabled())) throw new Paused(); }

export type Source = "chat" | "voice" | "mission" | "phone" | "system" | "autopilot";
export async function audit(source: Source, kind: string, detail: string, status: "done" | "blocked" | "failed" | "awaiting" = "done", payload?: unknown) {
  await ins("audit", { source, kind, detail: detail.slice(0, 400), status, payload: payload ?? null }).catch(() => null);
}
