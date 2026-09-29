"use client";
import { useState } from "react";

export default function Login() {
  const [pass, setPass] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pass }) });
    if (r.ok) location.href = "/"; else { setErr((await r.json()).error ?? "Denied"); setBusy(false); }
  }
  return (
    <main className="login">
      <div className="reactor sleeping small"><i /><i /><i /><b /></div>
      <h1>NOVA</h1>
      <p className="dim">Identity verification required</p>
      <form onSubmit={go}>
        <input type="password" autoFocus placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
        <button disabled={busy || !pass}>{busy ? "Verifying…" : "Authenticate"}</button>
      </form>
      {err && <p className="err">{err}</p>}
    </main>
  );
}
