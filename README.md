# NOVA — personal intelligence

A cinematic, voice-first (Hinglish + English) personal AI that runs **free** on Vercel Hobby + Supabase Free + Groq/Gemini free tiers.

## What it does (honestly)

| Module | Status | How |
|---|---|---|
| Wake word “NOVA” + voice replies | ✅ | Browser Web Speech API (`hi-IN`), Chrome/Edge, tab open. Tap the reactor or **Alt+N** for a manual trigger. |
| Brain | ✅ | NVIDIA NIM `meta/llama-3.3-70b-instruct` → Groq `llama-3.3-70b-versatile` → Gemini. Memory/ledger/contacts never go to Gemini. |
| **Action engine** | ✅ | “NOVA, Mummy ko WhatsApp karo…”, “Rahul ko call karo”, “India Gate ka rasta”, “YouTube pe lo-fi chalao”, “Zomato kholo”, “kal 9 baje meeting yaad dilana”, “10 min timer”, “mausam kaisa hai”. 16 whitelisted actions; **Direct mode** launches the app instantly, you press the final Send/Call. Payments are never an action. |
| Stock analyser | ✅ educational | Yahoo daily candles (delayed). RSI-14, SMA-20/50, ATR-14 and volume are computed in code; the LLM only explains them. No buy/sell calls. |
| Pre-trade checklist + paper journal | ✅ | Rule-based template (1.5×ATR stop, 2:1). Scored each day against real highs/lows. |
| Income & business engine | ✅ approval-gated | Generates ideas into the **Approval Queue**, learns from your rejection reasons. |
| Self-improvement protocol | ✅ approval-gated | Each day proposes one new rule, **A/B tests it on your real past question** and shows before/after. Applied only when you approve. |
| Ledger (“tracks funds”) | ✅ manual | “NOVA, 500 rupees kharch hua chai pe”. Only numbers you enter; nothing is invented. |
| Memory | ✅ | “NOVA, yaad rakhna ki…” |
| Notifications | ✅ | Browser notification when the daily briefing is ready. |
| Background control with screen off | ⏭ next | Telegram voice bot + Tasker bridge (allow-listed verbs, push-woken). |
| Payments, bank/broker actions | ❌ by design | NOVA never moves money. |

## Architecture

```
app/page.tsx              HUD: arc reactor, approval queue, metrics, market lens, journal
app/api/agent/route.ts    Brain: intent routing (Hinglish/English/Devanagari), stocks, ideas, approvals
app/api/cron/route.ts     Daily Protocol at 08:00 IST (Mon–Sat), protected by CRON_SECRET
hooks/useJarvisVoice.ts   Wake word, continuous recognition, bilingual TTS
lib/llm.ts                NVIDIA → Groq → Gemini router
lib/actions.ts            Action whitelist + deep-link builders (Android intents, wa.me, tel:, maps…)
lib/tools.ts              Action planner, contact lookup, weather (Open-Meteo), reminders
components/Core.tsx       Canvas neural core, voice-reactive
lib/market.ts             Yahoo data + indicators + paper-trade scoring
lib/nova.ts               Persona, idea engine, self-improvement A/B test, daily briefing
lib/db.ts                 Minimal Supabase REST client
middleware.ts             Passphrase gate for every page and API
```

Security: every page and API sits behind `NOVA_PASSPHRASE` (httpOnly cookie). Supabase tables use row-level security, and the only access path is a server-only `x-nova-key` header checked by a private function. No keys ever reach the browser.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `NOVA_PASSPHRASE` | yes | Your login |
| `NVIDIA_API_KEY` | recommended | Free credits at build.nvidia.com (primary brain) |
| `GROQ_API_KEY` | yes (fallback) | Free at console.groq.com/keys |
| `GEMINI_API_KEY` | optional | Free at aistudio.google.com/apikey (fallback) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | yes | Supabase project settings |
| `NOVA_DB_SECRET` | yes | Must equal `private.config.api_secret` in the database |
| `CRON_SECRET` | yes | Vercel sends it to `/api/cron` |

## Notes
- For personal, non-commercial use (Vercel Hobby terms).
- Market data is delayed and unofficial. Educational only. NOVA is not SEBI-registered.
- Back up anytime with **⤓ Export**.
