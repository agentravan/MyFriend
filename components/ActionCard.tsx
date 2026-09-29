"use client";
// One executable action. Launch-type actions open the target app/site; Phone Link actions run on the user's phone.
import { useState } from "react";
import { Action, actionUrl, describe, INTERNAL } from "@/lib/actions";

const ICON: Record<string, string> = {
  whatsapp: "💬", call: "📞", sms: "✉️", email: "📧", maps: "🧭", youtube: "▶️", music: "🎵", search: "🔎", open_app: "📱",
  open_url: "🌐", calendar: "📅", timer: "⏱️", reminder: "⏰", note: "📝", save_contact: "👤", weather: "🌦️", task: "🎯", phone: "📲",
};
export const isAndroid = () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
export const via = (a: Action) => (a as { via?: string }).via;

/** Try to launch; returns false if the browser blocked it (needs a tap). */
export function launch(a: Action): boolean {
  const url = actionUrl(a, isAndroid());
  if (!url) return false;
  if (/^(tel|sms|mailto|whatsapp|intent):/.test(url)) { location.href = url; return true; }
  return !!window.open(url, "_blank", "noopener");
}

type Picker = { select: (p: string[], o?: object) => Promise<{ name?: string[]; tel?: string[] }[]> };

export default function ActionCard({ a, auto, onContact, onPhoneSend }: {
  a: Action; auto?: boolean; onContact: (name: string, phone: string) => void; onPhoneSend: (a: Action) => void;
}) {
  const [act, setAct] = useState(a), [state, setState] = useState<"ready" | "done">(auto || via(a) === "phone" ? "done" : "ready");
  const internal = INTERNAL.has(act.kind) || via(act) === "phone";
  const needsPhone = act.kind === "call" && !act.phone;
  const picker = typeof navigator !== "undefined" && "contacts" in navigator ? (navigator as unknown as { contacts: Picker }).contacts : null;

  async function pick() {
    try {
      const [c] = await picker!.select(["name", "tel"], { multiple: false });
      const phone = c?.tel?.[0]; if (!phone) return;
      const name = ("name" in act && act.name) || c.name?.[0] || "Contact";
      onContact(name, phone);
      const next = { ...act, phone, name } as Action;
      setAct(next); setState(launch(next) ? "done" : "ready");
    } catch { /* cancelled */ }
  }

  const label = via(act) === "confirm" ? "SAY “HAAN” TO START" : via(act) === "phone" ? "DONE ON YOUR PHONE" : internal ? "DONE" : state === "done" ? "OPENED" : via(act) === "phone-confirm" ? "SAY “HAAN, BHEJ DO” OR TAP" : "READY";
  return (
    <div className={`act ${(internal || state === "done") && via(act) !== "confirm" ? "ok" : ""}`}>
      <span className="act-ic">{ICON[act.kind] ?? "•"}</span>
      <div className="act-body"><small>{label}</small><p>{describe(act)}</p></div>
      {!internal && (via(act) === "phone-confirm"
        ? <button className="primary" onClick={() => { onPhoneSend(act); setState("done"); }}>Send from phone</button>
        : needsPhone
          ? picker ? <button onClick={pick}>Pick contact</button> : null
          : <button className="primary" onClick={() => setState(launch(act) ? "done" : "ready")}>{state === "done" ? "Open again" : "Open"}</button>)}
    </div>
  );
}
