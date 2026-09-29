// Server-side tools the action planner can use: planning, contact lookup, weather, persistence of internal actions.
import { llm, parseJSON, Msg } from "@/lib/llm";
import { Action, sanitize } from "@/lib/actions";
import { ins, sel } from "@/lib/db";
import { createTask } from "@/lib/agents";
import { phone, setting, PhoneOp } from "@/lib/phone";

const nowIST = () => new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" });

const PLANNER = `You are NOVA's action planner (female persona, Hinglish/English). Output ONLY one JSON object:
{"reply":"<1-2 short spoken sentences in the user's language (Roman Hinglish if they used Hindi)>","actions":[ ...0-3 actions... ]}
Allowed actions (exact keys):
{"kind":"whatsapp","name":"<contact name if said>","phone":"<only digits the user said>","text":"<message>"}
{"kind":"call","name":"","phone":""}
{"kind":"sms","name":"","phone":"","text":""}
{"kind":"email","to":"<email if said>","subject":"","body":""}
{"kind":"maps","query":"<place>","directions":true|false}
{"kind":"youtube","query":""}   {"kind":"music","query":""}   {"kind":"search","query":""}
{"kind":"open_app","app":"<one of: whatsapp, youtube, instagram, facebook, telegram, gmail, maps, chrome, spotify, youtube music, zomato, swiggy, uber, ola, rapido, irctc, amazon, flipkart, blinkit, zepto, linkedin, x, netflix, hotstar, calendar, zerodha, groww>"}
{"kind":"open_url","url":"https://..."}
{"kind":"calendar","title":"","start":"<ISO 8601 +05:30>","end":"<optional ISO>","details":""}
{"kind":"timer","seconds":<number>,"label":""}
{"kind":"reminder","text":"","due_at":"<ISO 8601 +05:30>"}
{"kind":"note","text":""}
{"kind":"save_contact","name":"","phone":"<digits>"}
{"kind":"weather","place":"<city, default Gurugram>"}
{"kind":"task","goal":"<the full goal, rewritten clearly in English with all details the user gave>"}
{"kind":"phone","op":"answer|end_call|speaker_on|torch_on|torch_off|silent|vibrate|ring|find_phone"}   (controls the user's linked Android phone)
USE "task" for any multi-step work NOVA should do on its own: research, finding clients/leads, market/competitor analysis, business plans,
building dashboards/websites/apps/tools, reports, proposals, spreadsheets, summarising attached files, earning-money plans. Reply e.g. "Sure Boss, I'm on it." 
RULES:
- Only add actions when the user asks you to DO something. Questions/chat → "actions": [] and answer in "reply".
- NEVER invent phone numbers or emails. Put the person's name in "name"; NOVA looks it up.
- Write WhatsApp/SMS text exactly as the user would send it (same language/tone), not as instructions.
- Payments, money transfers, UPI, banking, buying, deleting data: no action. Say you can't move money, only open the app if asked.
- Resolve relative times ("5 min baad", "kal subah 7 baje") against the current time given below.
- Reply like a sharp assistant: "Ho gaya Boss", "WhatsApp khol rahi hoon". Never claim a message was SENT — the user taps send.`;

export async function plan(text: string, hist: Msg[], system: string, privateCtx: string) {
  const { text: out, provider } = await llm({
    system: `${system}\n\n${PLANNER}\nCURRENT TIME: ${nowIST()} (IST, UTC+05:30). ISO now: ${new Date().toISOString()}`,
    privateCtx, json: true, maxTokens: 600, temperature: 0.3,
    msgs: [...hist.slice(-6), { role: "user", content: text }],
  });
  const j = parseJSON<{ reply?: string; actions?: unknown }>(out, {});
  // If the model ignored JSON, treat its text as a plain reply.
  return { reply: j.reply ?? (out.trim().startsWith("{") ? "Samajh nahi paayi, dobara bolo Boss." : out), actions: sanitize(j.actions), provider };
}

const WMO: Record<number, string> = { 0: "saaf aasmaan ☀️", 1: "zyaadatar saaf", 2: "halke baadal ⛅", 3: "baadal ☁️", 45: "kohra 🌫️", 48: "kohra",
  51: "halki boondabaandi", 61: "halki baarish 🌧️", 63: "baarish 🌧️", 65: "tez baarish", 80: "bauchhaar", 95: "toofan ⛈️" };

export async function weather(place: string) {
  const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en`)).json();
  const loc = g.results?.[0];
  if (!loc) return `${place} nahi mila, city ka naam dobara bolo.`;
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FKolkata&forecast_days=1`)).json();
  const c = w.current, d = w.daily;
  return `${loc.name} mein abhi ${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C), ${WMO[c.weather_code] ?? "mausam normal"}. ` +
    `Aaj ${Math.round(d.temperature_2m_min[0])}–${Math.round(d.temperature_2m_max[0])}°C, baarish ka chance ${d.precipitation_probability_max[0] ?? 0}%. Humidity ${c.relative_humidity_2m}%.`;
}

/** Resolve names → numbers from saved contacts, persist internal actions. Returns extra reply text. */
export async function execServer(actions: Action[], opt: { voice?: boolean } = {}) {
  const notes: string[] = [];
  const linked = !!(await setting("phone_webhook").catch(() => undefined));
  for (const a of actions) {
    if ((a.kind === "whatsapp" || a.kind === "call" || a.kind === "sms") && !a.phone && a.name) {
      const q = encodeURIComponent(`*${a.name.replace(/[*,()]/g, "").trim()}*`);
      const [c] = await sel("contacts", `name=ilike.${q}&limit=1`);
      if (c) { a.phone = c.phone; a.name = c.name; }
    }
    const tag = a as { via?: string };
    if (a.kind === "call" && linked && a.phone) {           // Phone Link: dial directly from the phone
      try { await phone("call", { number: a.phone, name: a.name }); tag.via = "phone"; } catch (e) { notes.push((e as Error).message); }
    }
    if (a.kind === "sms" && linked && a.phone) tag.via = "phone-confirm";  // SMS goes out only after "haan, bhej do"
    if (a.kind === "phone") {
      if (!linked) notes.push("Phone Link abhi set nahi hai — Settings → Phone Link se 2 minute mein connect karo.");
      else try { await phone(a.op as PhoneOp); tag.via = "phone"; } catch (e) { notes.push((e as Error).message); }
    }
    if (a.kind === "note") await ins("memory", { fact: a.text });
    if (a.kind === "save_contact") await ins("contacts", { name: a.name, phone: a.phone.replace(/[^\d+]/g, "") }).catch(() => notes.push(`${a.name} pehle se saved hai.`));
    if (a.kind === "reminder") await ins("reminders", { text: a.text, due_at: a.due_at });
    if (a.kind === "task") {
      if (opt.voice) tag.via = "confirm"; // spoken → Boss confirms before any work starts
      else { const t = await createTask(a.goal); (a as { id?: number }).id = t.id; }
    }
    if (a.kind === "weather") notes.push(await weather(a.place || "Gurugram").catch(() => "Weather service abhi respond nahi kar rahi."));
  }
  if (actions.length) await ins("actions", actions.map((a) => ({ kind: a.kind, payload: a }))).catch(() => null);
  return notes.join(" ");
}
