import { NextResponse } from "next/server";
import { COOKIE, token } from "@/lib/auth";

export async function POST(req: Request) {
  const { pass } = await req.json().catch(() => ({ pass: "" }));
  const real = process.env.NOVA_PASSPHRASE;
  if (!real) return NextResponse.json({ error: "NOVA_PASSPHRASE is not set on the server." }, { status: 500 });
  await new Promise((r) => setTimeout(r, 400)); // slow brute force
  if (pass !== real) return NextResponse.json({ error: "Wrong passphrase" }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, await token(real), {
    httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
