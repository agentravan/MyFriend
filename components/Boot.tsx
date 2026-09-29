"use client";
// Cinematic boot sequence, once per browser session.
import { useEffect, useState } from "react";

const LINES = ["NOVA OS v2.0 — personal intelligence", "Initializing neural core", "Linking brain: NVIDIA · Groq · Gemini",
  "Loading memory, contacts & reminders", "Arming action engine (16 capabilities)", "Voice matrix: हिन्दी + English", "All systems nominal"];

export default function Boot() {
  const [n, setN] = useState(0), [done, setDone] = useState(true);
  useEffect(() => {
    let seen = false;
    try { seen = sessionStorage.getItem("nova_boot") === "1"; sessionStorage.setItem("nova_boot", "1"); } catch { /* private mode */ }
    if (seen) return;
    setDone(false);
    const iv = setInterval(() => setN((x) => x + 1), 230);
    const end = setTimeout(() => { clearInterval(iv); setDone(true); }, 230 * (LINES.length + 3));
    return () => { clearInterval(iv); clearTimeout(end); };
  }, []);
  if (done) return null;
  return (
    <div className="boot" onClick={() => setDone(true)}>
      <div className="boot-logo">NOVA</div>
      <div className="boot-lines">
        {LINES.slice(0, n).map((l, i) => (
          <p key={l}><span>{String(i).padStart(2, "0")}</span> {l}{i < LINES.length - 1 ? <b> ✓</b> : null}</p>
        ))}
      </div>
      <div className="boot-bar"><i style={{ width: `${Math.min(100, (n / LINES.length) * 100)}%` }} /></div>
    </div>
  );
}
