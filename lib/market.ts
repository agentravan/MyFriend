// Market data (Yahoo chart endpoint, delayed/unofficial) + indicators computed in code — never by the LLM.
export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

const NAMES: Record<string, string> = {
  reliance: "RELIANCE", "रिलायंस": "RELIANCE", tcs: "TCS", "टीसीएस": "TCS", infosys: "INFY", infy: "INFY",
  "इंफोसिस": "INFY", "hdfc bank": "HDFCBANK", hdfc: "HDFCBANK", "एचडीएफसी": "HDFCBANK", icici: "ICICIBANK",
  sbi: "SBIN", "एसबीआई": "SBIN", "state bank": "SBIN", itc: "ITC", wipro: "WIPRO", "विप्रो": "WIPRO",
  airtel: "BHARTIARTL", "bharti airtel": "BHARTIARTL", tata_motors: "TATAMOTORS", "tata motors": "TATAMOTORS",
  "टाटा मोटर्स": "TATAMOTORS", "tata steel": "TATASTEEL", adani: "ADANIENT", "अदानी": "ADANIENT", zomato: "ETERNAL",
  eternal: "ETERNAL", "l&t": "LT", larsen: "LT", maruti: "MARUTI", "मारुति": "MARUTI", "bajaj finance": "BAJFINANCE",
  "asian paints": "ASIANPAINT", hul: "HINDUNILVR", "hindustan unilever": "HINDUNILVR", nifty: "^NSEI", "निफ्टी": "^NSEI",
  "bank nifty": "^NSEBANK", banknifty: "^NSEBANK", sensex: "^BSESN", "सेंसेक्स": "^BSESN",
};

/** Find a ticker in free text: known names first, then an explicit CAPS token like "TATAPOWER" or "IRFC.NS". */
export function findSymbol(text: string): string | null {
  const low = ` ${text.toLowerCase()} `;
  const esc = (k: string) => k.replace("_", " ").replace(/[&.]/g, "\\$&");
  const hit = Object.keys(NAMES).sort((a, b) => b.length - a.length)
    .find((k) => (/^[a-z]/.test(k) ? new RegExp(`[^a-z]${esc(k)}[^a-z]`).test(low) : low.includes(k)));
  if (hit) return NAMES[hit];
  const stop = new Set(["NOVA", "RSI", "SMA", "EMA", "ATR", "OK", "AI", "BUY", "SELL", "NSE", "BSE", "HI", "NO",
    "YES", "THE", "ME", "MY", "IS", "IT", "TO", "DO", "GO", "PE", "KO", "KA", "KI", "HAI", "SIP", "IPO", "ETF", "USA", "INR"]);
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9&]{1,14})(\.(NS|BO))?\b/g)) if (!stop.has(m[1])) return m[0];
  return null;
}

const ysym = (s: string) => (s.startsWith("^") || s.includes(".") ? s : `${s}.NS`);

export async function bars(symbol: string, range = "6mo"): Promise<{ bars: Bar[]; asOf: number; name: string; cur: string }> {
  const url = (h: string) =>
    `https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ysym(symbol))}?range=${range}&interval=1d`;
  let lastErr = "";
  for (const h of ["query1", "query2"]) {
    const r = await fetch(url(h), { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 300 } });
    if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
    const res = (await r.json()).chart?.result?.[0];
    if (!res) { lastErr = "symbol not found"; continue; }
    const q = res.indicators.quote[0];
    const out: Bar[] = res.timestamp
      .map((t: number, i: number) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] ?? 0 }))
      .filter((b: Bar) => b.c != null && b.h != null && b.l != null);
    return { bars: out, asOf: (res.meta.regularMarketTime ?? 0) * 1000, name: res.meta.shortName ?? symbol, cur: res.meta.currency ?? "INR" };
  }
  throw new Error(`Market data unavailable for ${symbol} (${lastErr})`);
}

const sma = (a: number[], n: number) => (a.length >= n ? a.slice(-n).reduce((x, y) => x + y, 0) / n : NaN);

function rsi(c: number[], n = 14) {
  if (c.length <= n) return NaN;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function atr(b: Bar[], n = 14) {
  const tr = b.slice(1).map((x, i) => Math.max(x.h - x.l, Math.abs(x.h - b[i].c), Math.abs(x.l - b[i].c)));
  return sma(tr, n);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export async function analyze(symbol: string) {
  const { bars: b, asOf, name, cur } = await bars(symbol);
  const c = b.map((x) => x.c), last = b[b.length - 1], prev = b[b.length - 2] ?? last;
  const s20 = sma(c, 20), s50 = sma(c, 50), R = rsi(c), A = atr(b);
  const volRatio = last.v / sma(b.map((x) => x.v), 20);
  const hi = Math.max(...b.map((x) => x.h)), lo = Math.min(...b.map((x) => x.l));
  const trend = last.c > s20 && s20 > s50 ? "uptrend structure (price > SMA20 > SMA50)"
    : last.c < s20 && s20 < s50 ? "downtrend structure (price < SMA20 < SMA50)" : "mixed / sideways";
  const rsiNote = R >= 70 ? "overbought zone (>70)" : R <= 30 ? "oversold zone (<30)" : "neutral zone (30–70)";
  return {
    symbol, name, currency: cur, asOf,
    price: r2(last.c), changePct: r2(((last.c - prev.c) / prev.c) * 100),
    sma20: r2(s20), sma50: r2(s50), rsi14: r2(R), atr14: r2(A), volRatio: r2(volRatio),
    high6m: r2(hi), low6m: r2(lo), trend, rsiNote,
    // Rule-based PAPER template (2:1 reward:risk using ATR). Educational, not a recommendation.
    paper: { entry: r2(last.c), stop: r2(last.c - 1.5 * A), target: r2(last.c + 3 * A) },
  };
}
export type Analysis = Awaited<ReturnType<typeof analyze>>;

/** Score an open paper trade against daily highs/lows since it was opened. Stop checked first (conservative). */
export async function score(t: { symbol: string; stop: number; target: number; openedAt: number }) {
  const { bars: b } = await bars(t.symbol, "3mo");
  for (const x of b.filter((x) => x.t > t.openedAt)) {
    if (x.l <= t.stop) return { status: "loss" as const, exit: t.stop, at: x.t };
    if (x.h >= t.target) return { status: "win" as const, exit: t.target, at: x.t };
  }
  return null;
}
