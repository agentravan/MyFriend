// Task engine API (passphrase-protected): create goals, advance work, resume after manual steps, cancel/retry.
import { NextResponse } from "next/server";
import { createTask, resume, tick } from "@/lib/agents";
import { upd } from "@/lib/db";
import { snapshot } from "@/lib/db";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function extract(file?: { name: string; b64?: string; text?: string }) {
  if (!file) return undefined;
  if (file.text) return `FILE ${file.name}:\n${file.text}`;
  if (file.b64 && /\.pdf$/i.test(file.name)) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(file.b64, "base64")));
    const { text } = await extractText(pdf, { mergePages: true });
    return `PDF ${file.name} (${pdf.numPages} pages):\n${text}`;
  }
  return undefined;
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    let out: Record<string, unknown> = {};
    switch (b.action) {
      case "create": {
        const t = await createTask(String(b.goal ?? "").trim(), await extract(b.file));
        out = { task: t, reply: "Sure Boss, I'm on it." }; break;
      }
      case "tick": out = { tick: await tick() }; break;
      case "resume": await resume(Number(b.id), String(b.input ?? "")); break;
      case "cancel": await upd("tasks", `id=eq.${Number(b.id)}`, { status: "cancelled", phase: "Cancelled", updated_at: new Date().toISOString() }); break;
      case "retry":
        await upd("steps", `task_id=eq.${Number(b.id)}&status=eq.failed`, { status: "pending", attempts: 0 });
        await upd("tasks", `id=eq.${Number(b.id)}`, { status: "running", phase: "Retrying", updated_at: new Date().toISOString() }); break;
    }
    return NextResponse.json({ ...out, state: await snapshot() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
