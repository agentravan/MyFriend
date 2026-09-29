// NOVA action engine — a closed whitelist. The LLM may only emit these kinds; anything else is dropped in code.
// Shared by server (validation) and client (execution). Money movement is never an action.
export type Action =
  | { kind: "whatsapp"; name?: string; phone?: string; text: string }
  | { kind: "call"; name?: string; phone?: string }
  | { kind: "sms"; name?: string; phone?: string; text: string }
  | { kind: "email"; to?: string; subject?: string; body?: string }
  | { kind: "maps"; query: string; directions?: boolean }
  | { kind: "youtube"; query: string }
  | { kind: "music"; query: string }
  | { kind: "search"; query: string }
  | { kind: "open_app"; app: string }
  | { kind: "open_url"; url: string }
  | { kind: "calendar"; title: string; start: string; end?: string; details?: string }
  | { kind: "timer"; seconds: number; label?: string }
  | { kind: "reminder"; text: string; due_at: string }
  | { kind: "note"; text: string }
  | { kind: "save_contact"; name: string; phone: string }
  | { kind: "weather"; place: string };

export const KINDS = ["whatsapp", "call", "sms", "email", "maps", "youtube", "music", "search", "open_app", "open_url",
  "calendar", "timer", "reminder", "note", "save_contact", "weather"] as const;
/** Handled inside NOVA (no app switch). Everything else launches another app/site. */
export const INTERNAL = new Set(["timer", "reminder", "note", "save_contact", "weather"]);

// name → [android package, web fallback]
export const APPS: Record<string, [string, string]> = {
  whatsapp: ["com.whatsapp", "https://web.whatsapp.com"], youtube: ["com.google.android.youtube", "https://m.youtube.com"],
  instagram: ["com.instagram.android", "https://www.instagram.com"], facebook: ["com.facebook.katana", "https://m.facebook.com"],
  telegram: ["org.telegram.messenger", "https://web.telegram.org"], gmail: ["com.google.android.gm", "https://mail.google.com"],
  maps: ["com.google.android.apps.maps", "https://maps.google.com"], chrome: ["com.android.chrome", "https://google.com"],
  spotify: ["com.spotify.music", "https://open.spotify.com"], "youtube music": ["com.google.android.apps.youtube.music", "https://music.youtube.com"],
  zomato: ["com.application.zomato", "https://www.zomato.com"], swiggy: ["in.swiggy.android", "https://www.swiggy.com"],
  uber: ["com.ubercab", "https://m.uber.com"], ola: ["com.olacabs.customer", "https://book.olacabs.com"],
  rapido: ["com.rapido.passenger", "https://www.rapido.bike"], irctc: ["cris.org.in.prs.ima", "https://www.irctc.co.in"],
  amazon: ["in.amazon.mShop.android.shopping", "https://www.amazon.in"], flipkart: ["com.flipkart.android", "https://www.flipkart.com"],
  blinkit: ["com.grofers.customerapp", "https://blinkit.com"], zepto: ["com.zeptoconsumerapp", "https://www.zeptonow.com"],
  linkedin: ["com.linkedin.android", "https://www.linkedin.com"], x: ["com.twitter.android", "https://x.com"],
  netflix: ["com.netflix.mediaclient", "https://www.netflix.com"], hotstar: ["in.startv.hotstar", "https://www.hotstar.com"],
  calendar: ["com.google.android.calendar", "https://calendar.google.com"],
  zerodha: ["com.zerodha.kite3", "https://kite.zerodha.com"], groww: ["com.nextbillion.groww", "https://groww.in"],
};

const enc = encodeURIComponent;
export const normPhone = (p?: string) => {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length === 10 ? "91" + d : d.length === 12 && d.startsWith("91") ? d : d.length === 11 && d.startsWith("0") ? "91" + d.slice(1) : d;
};
const gcal = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Build the URL that performs a launch-type action on this device. */
export function actionUrl(a: Action, android: boolean): string | null {
  switch (a.kind) {
    case "whatsapp": {
      const ph = normPhone(a.phone);
      return android ? `whatsapp://send?${ph ? `phone=${ph}&` : ""}text=${enc(a.text)}` : `https://wa.me/${ph}?text=${enc(a.text)}`;
    }
    case "call": return a.phone ? `tel:+${normPhone(a.phone)}` : null;
    case "sms": return `sms:${a.phone ? "+" + normPhone(a.phone) : ""}?body=${enc(a.text)}`;
    case "email": return `mailto:${a.to ?? ""}?subject=${enc(a.subject ?? "")}&body=${enc(a.body ?? "")}`;
    case "maps": return a.directions ? `https://www.google.com/maps/dir/?api=1&destination=${enc(a.query)}` : `https://www.google.com/maps/search/?api=1&query=${enc(a.query)}`;
    case "youtube": return `https://www.youtube.com/results?search_query=${enc(a.query)}`;
    case "music": return `https://music.youtube.com/search?q=${enc(a.query)}`;
    case "search": return `https://www.google.com/search?q=${enc(a.query)}`;
    case "open_url": return /^https:\/\//.test(a.url) ? a.url : null;
    case "calendar": {
      const end = a.end ?? new Date(new Date(a.start).getTime() + 3600e3).toISOString();
      return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(a.title)}&dates=${gcal(a.start)}/${gcal(end)}&details=${enc(a.details ?? "Added by NOVA")}`;
    }
    case "open_app": {
      const [pkg, web] = APPS[a.app.toLowerCase()] ?? [];
      if (!pkg && !web) return null;
      return android && pkg
        ? `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${pkg};S.browser_fallback_url=${enc(web)};end`
        : web;
    }
    default: return null;
  }
}

export function describe(a: Action): string {
  switch (a.kind) {
    case "whatsapp": return `WhatsApp → ${a.name ?? a.phone ?? "choose contact"}: “${a.text}”`;
    case "call": return `Call ${a.name ?? ""} ${a.phone ? "+" + normPhone(a.phone) : "(number needed)"}`;
    case "sms": return `SMS → ${a.name ?? a.phone ?? "choose"}: “${a.text}”`;
    case "email": return `Email → ${a.to ?? "?"}: ${a.subject ?? ""}`;
    case "maps": return `${a.directions ? "Directions to" : "Map"}: ${a.query}`;
    case "youtube": return `YouTube: ${a.query}`;
    case "music": return `Music: ${a.query}`;
    case "search": return `Google: ${a.query}`;
    case "open_app": return `Open ${a.app}`;
    case "open_url": return `Open ${a.url}`;
    case "calendar": return `Calendar: ${a.title} · ${new Date(a.start).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}`;
    case "timer": return `Timer ${Math.round(a.seconds / 60) || a.seconds + "s"}${a.seconds >= 60 ? " min" : ""}${a.label ? " · " + a.label : ""}`;
    case "reminder": return `Reminder: ${a.text} · ${new Date(a.due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}`;
    case "note": return `Note saved: ${a.text}`;
    case "save_contact": return `Contact saved: ${a.name} (${a.phone})`;
    case "weather": return `Weather: ${a.place}`;
  }
}

/** Server-side validation: keep only whitelisted, well-formed actions. */
export function sanitize(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).filter((a): a is Action =>
    !!a && typeof a === "object" && (KINDS as readonly string[]).includes((a as Action).kind)
    && !((a as Action).kind === "open_url" && !/^https:\/\//.test((a as { url?: string }).url ?? ""))
    && !((a as Action).kind === "timer" && !((a as { seconds?: number }).seconds! > 0)));
}
