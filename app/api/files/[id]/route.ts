// Deliverables: ?dl=1 downloads; otherwise opens inline. Generated HTML runs in a CSP sandbox (opaque origin, no cookies).
import { sel } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [f] = await sel("files", `id=eq.${Number(id)}&limit=1`);
  if (!f) return new Response("Not found", { status: 404 });
  const dl = new URL(req.url).searchParams.has("dl");
  const inlineText = !dl && /^text\/(csv|markdown)$/.test(f.mime);
  return new Response(f.content, {
    headers: {
      "Content-Type": `${inlineText ? "text/plain" : f.mime}; charset=utf-8`,
      "Content-Disposition": `${dl ? "attachment" : "inline"}; filename="${String(f.name).replace(/"/g, "")}"`,
      "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads",
      "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
    },
  });
}
