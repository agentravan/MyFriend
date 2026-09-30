// Tiny Supabase REST client. Server-only: every request carries the x-nova-key secret checked by RLS.
const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_ANON_KEY ?? "", S = process.env.NOVA_DB_SECRET ?? "";

async function db<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!U) throw new Error("SUPABASE_URL not set");
  const r = await fetch(`${U}/rest/v1/${path}`, {
    ...init, cache: "no-store",
    headers: {
      apikey: K, ...(K.startsWith("eyJ") && { Authorization: `Bearer ${K}` }),
      "x-nova-key": S, "Content-Type": "application/json", Prefer: "return=representation",
    },
  });
  if (!r.ok) throw new Error(`db ${r.status}: ${await r.text()}`);
  return (r.status === 204 ? null : await r.json()) as T;
}

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const sel = (t: string, q = "") => db<Row[]>(`${t}?${q}`);
export const ins = (t: string, row: Row | Row[]) => db<Row[]>(t, { method: "POST", body: JSON.stringify(row) });
export const upd = (t: string, q: string, row: Row) => db<Row[]>(`${t}?${q}`, { method: "PATCH", body: JSON.stringify(row) });
export const del = (t: string, q: string) => db<Row[]>(`${t}?${q}`, { method: "DELETE" });

/** Everything the dashboard needs, in one round trip batch. */
export async function snapshot() {
  const [messages, proposals, trades, ledger, memory, addenda, watchlist, digests, contacts, reminders, actions] = await Promise.all([
    sel("messages", "order=at.desc&limit=40"),
    sel("proposals", "order=at.desc&limit=60"),
    sel("trades", "order=opened_at.desc&limit=100"),
    sel("ledger", "order=at.desc&limit=200"),
    sel("memory", "order=at.desc&limit=50"),
    sel("addenda", "order=at.asc"),
    sel("watchlist", "order=at.asc"),
    sel("digests", "order=day.desc&limit=1"),
    sel("contacts", "order=name.asc&limit=300"),
    sel("reminders", "done=eq.false&order=due_at.asc&limit=50"),
    sel("actions", "order=at.desc&limit=30"),
  ]);
  const [tasks, files, settings, events, audit, learnings] = await Promise.all([
    sel("tasks", "select=id,title,goal,kind,status,phase,summary,needs,created_at,updated_at&order=updated_at.desc&limit=25"),
    sel("files", "select=id,task_id,name,mime,size,created_at&order=created_at.desc&limit=40"),
    sel("settings", "key=in.(phone_webhook,device_key,nova_enabled,autopilot)").catch(() => []),
    sel("device_events", "seen=eq.false&order=at.desc&limit=5").catch(() => []),
    sel("audit", "select=id,at,source,kind,detail,status&order=at.desc&limit=80").catch(() => []),
    sel("learnings", "active=eq.true&order=at.desc&limit=50").catch(() => []),
  ]);
  const cfg = Object.fromEntries(settings.map((x) => [x.key, x.value]));
  const steps = tasks.length ? await sel("steps", `select=id,task_id,idx,agent,title,status,manual,instruction&task_id=in.(${tasks.slice(0, 8).map((t) => t.id).join(",")})&order=idx.asc`) : [];
  const closed = trades.filter((t) => t.status !== "open"), wins = closed.filter((t) => t.status === "win").length;
  const month = new Date().toISOString().slice(0, 7);
  const monthLedger = ledger.filter((l) => String(l.at).startsWith(month));
  return {
    messages: messages.reverse(), proposals, trades, ledger, memory, addenda, watchlist, digest: digests[0] ?? null,
    contacts, reminders, actions, tasks, steps, files, events, audit, learnings,
    power: { on: cfg.nova_enabled !== "off", autopilot: cfg.autopilot === "on" },
    phone: { linked: !!cfg.phone_webhook, deviceKey: (cfg.device_key as string) ?? null },
    metrics: {
      pending: proposals.filter((p) => p.status === "pending" && p.kind !== "next").length,
      nextMoves: proposals.filter((p) => p.status === "pending" && p.kind === "next").length,
      activeTasks: tasks.filter((t) => ["planning", "running"].includes(t.status)).length,
      waiting: tasks.filter((t) => t.status === "waiting_user").length,
      delivered: files.length,
      tasksToday: actions.filter((a) => String(a.at).slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
      ideasApproved: proposals.filter((p) => p.kind === "idea" && p.status === "approved").length,
      openTrades: trades.length - closed.length,
      hitRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
      closedTrades: closed.length,
      monthIn: monthLedger.filter((l) => +l.amount > 0).reduce((a, l) => a + +l.amount, 0),
      monthOut: monthLedger.filter((l) => +l.amount < 0).reduce((a, l) => a - +l.amount, 0),
    },
  };
}
export type Snapshot = Awaited<ReturnType<typeof snapshot>>;
