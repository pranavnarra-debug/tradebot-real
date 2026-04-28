import { alpacaData } from "./alpaca";
import { storage } from "./storage";

// ── News sentiment keywords ────────────────────────────────────────────────

const STRONGLY_NEGATIVE = [
  "fraud", "bankruptcy", "bankrupt", "sec investigation", "sec probe", "arrested",
  "indicted", "criminal", "ponzi", "accounting irregularities", "restatement",
  "delisted", "delisting", "chapter 11", "chapter 7", "insolvency", "insolvent",
  "fda rejected", "fda rejection", "complete response letter", "crl issued",
  "massive recall", "class action", "going concern", "liquidity crisis",
  "default", "missed payment", "catastrophic", "fatal flaw"
];

const MODERATELY_NEGATIVE = [
  "earnings miss", "missed estimates", "below expectations", "revenue decline",
  "guidance cut", "lowered guidance", "downgrade", "downgraded", "price target cut",
  "reduces price target", "lowers price target", "layoffs", "job cuts",
  "restructuring", "write-down", "writedown", "impairment", "loss widens",
  "disappointing", "weak demand", "slowing growth", "margin pressure",
  "recall", "investigation", "probe", "subpoena", "fine", "penalty",
  "disappointing quarter", "misses", "falls short", "below consensus"
];

const MILDLY_NEGATIVE = [
  "uncertainty", "headwinds", "challenges", "concern", "risk",
  "slower", "cautious", "neutral", "hold rating", "market perform",
  "inline", "in-line", "meets estimates" // meets = not a beat
];

const STRONGLY_POSITIVE = [
  "fda approved", "fda approval", "breakthrough designation", "acquisition",
  "acquired by", "merger agreement", "buyout", "takeover bid",
  "earnings beat", "blowout quarter", "record revenue", "record earnings",
  "massive contract", "major contract win", "partnership with",
  "strategic partnership", "blockbuster", "revolutionary", "game-changer",
  "upgraded to buy", "strong buy", "price target raised significantly"
];

const MODERATELY_POSITIVE = [
  "beats estimates", "above expectations", "raised guidance", "guidance raised",
  "upgrade", "upgraded", "price target raised", "raises price target",
  "strong demand", "growing market share", "margin expansion",
  "profitable", "turns profitable", "positive", "outperform",
  "buy rating", "strong quarter", "better than expected", "exceeds"
];

const MILDLY_POSITIVE = [
  "partnership", "collaboration", "new product", "product launch",
  "expansion", "new market", "hiring", "new ceo", "new contract",
  "renewed contract", "patent", "innovation", "progress"
];

export interface NewsItem {
  id: string;
  headline: string;
  summary: string;
  author: string;
  created_at: string;
  updated_at: string;
  url: string;
  symbols: string[];
  source: string;
}

export interface NewsSentiment {
  score: number;          // -25 to +20
  label: string;          // "strongly_negative" | "moderately_negative" | etc.
  convictionDelta: number; // how much to add/subtract from conviction
  shouldBlockEntry: boolean;
  coolingPeriodHours: number;
  headlines: string[];
  summary: string;
}

// ── Fetch news from Alpaca ─────────────────────────────────────────────────
export async function fetchNewsForSymbol(symbol: string, hoursBack = 24): Promise<NewsItem[]> {
  try {
    const start = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const r = await alpacaData.get("/v1beta1/news", {
      params: {
        symbols: symbol,
        start,
        limit: 10,
        sort: "desc",
      },
    });
    return r.data.news || [];
  } catch {
    return [];
  }
}

export async function fetchNewsForSymbols(symbols: string[], hoursBack = 24): Promise<Record<string, NewsItem[]>> {
  try {
    const start = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const r = await alpacaData.get("/v1beta1/news", {
      params: {
        symbols: symbols.join(","),
        start,
        limit: 50,
        sort: "desc",
      },
    });
    const news: NewsItem[] = r.data.news || [];
    const bySymbol: Record<string, NewsItem[]> = {};
    for (const item of news) {
      for (const sym of item.symbols) {
        if (!bySymbol[sym]) bySymbol[sym] = [];
        bySymbol[sym].push(item);
      }
    }
    return bySymbol;
  } catch {
    return {};
  }
}

// ── Analyze sentiment of news items ───────────────────────────────────────
export function analyzeNewsSentiment(newsItems: NewsItem[]): NewsSentiment {
  if (!newsItems.length) {
    return {
      score: 0,
      label: "neutral",
      convictionDelta: 0,
      shouldBlockEntry: false,
      coolingPeriodHours: 0,
      headlines: [],
      summary: "No recent news",
    };
  }

  let totalScore = 0;
  const headlines: string[] = [];

  for (const item of newsItems.slice(0, 5)) {
    const text = (item.headline + " " + (item.summary || "")).toLowerCase();
    headlines.push(item.headline);

    let itemScore = 0;

    // Check tiers — strongest match wins
    if (STRONGLY_NEGATIVE.some(kw => text.includes(kw))) {
      itemScore = -25;
    } else if (MODERATELY_NEGATIVE.some(kw => text.includes(kw))) {
      itemScore = -15;
    } else if (MILDLY_NEGATIVE.some(kw => text.includes(kw))) {
      itemScore = -5;
    } else if (STRONGLY_POSITIVE.some(kw => text.includes(kw))) {
      itemScore = +20;
    } else if (MODERATELY_POSITIVE.some(kw => text.includes(kw))) {
      itemScore = +15;
    } else if (MILDLY_POSITIVE.some(kw => text.includes(kw))) {
      itemScore = +7;
    }

    // Recency weighting — newer articles matter more
    const ageHours = (Date.now() - new Date(item.created_at).getTime()) / 3600000;
    const recencyWeight = ageHours < 2 ? 1.0 : ageHours < 6 ? 0.8 : ageHours < 12 ? 0.6 : 0.4;
    totalScore += itemScore * recencyWeight;
  }

  // Cap the total score
  totalScore = Math.max(-25, Math.min(20, Math.round(totalScore)));

  let label: string;
  let convictionDelta: number;
  let shouldBlockEntry: boolean;
  let coolingPeriodHours: number;
  let summary: string;

  if (totalScore <= -20) {
    label = "strongly_negative";
    convictionDelta = -25;
    shouldBlockEntry = true;
    coolingPeriodHours = 48;
    summary = "Major negative event detected — conviction severely reduced";
  } else if (totalScore <= -10) {
    label = "moderately_negative";
    convictionDelta = -15;
    shouldBlockEntry = true;
    coolingPeriodHours = 24;
    summary = "Negative news — blocking new entry, reducing conviction";
  } else if (totalScore <= -3) {
    label = "mildly_negative";
    convictionDelta = -8;
    shouldBlockEntry = false;
    coolingPeriodHours = 0;
    summary = "Mildly negative news — small conviction reduction";
  } else if (totalScore < 3) {
    label = "neutral";
    convictionDelta = 0;
    shouldBlockEntry = false;
    coolingPeriodHours = 0;
    summary = "Neutral news — no conviction change";
  } else if (totalScore < 10) {
    label = "mildly_positive";
    convictionDelta = +7;
    shouldBlockEntry = false;
    coolingPeriodHours = 0;
    summary = "Positive news — slight conviction boost";
  } else if (totalScore < 18) {
    label = "moderately_positive";
    convictionDelta = +15;
    shouldBlockEntry = false;
    coolingPeriodHours = 0;
    summary = "Strong positive news — conviction boosted";
  } else {
    label = "strongly_positive";
    convictionDelta = +20;
    shouldBlockEntry = false;
    coolingPeriodHours = 0;
    summary = "Major positive catalyst — significant conviction boost";
  }

  return { score: totalScore, label, convictionDelta, shouldBlockEntry, coolingPeriodHours, headlines, summary };
}

// ── Cooling period management ──────────────────────────────────────────────
export function isInCoolingPeriod(symbol: string): boolean {
  const key = `news_cooling_${symbol}`;
  const val = storage.getConfig(key);
  if (!val) return false;
  const until = new Date(val);
  return new Date() < until;
}

export function setCoolingPeriod(symbol: string, hours: number): void {
  if (hours <= 0) return;
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  storage.setConfig(`news_cooling_${symbol}`, until);
}

export function getCoolingPeriodEnd(symbol: string): string | null {
  return storage.getConfig(`news_cooling_${symbol}`) || null;
}

// ── Apply news sentiment to conviction score ───────────────────────────────
export function applyNewsSentiment(baseConviction: number, sentiment: NewsSentiment): number {
  const adjusted = baseConviction + sentiment.convictionDelta;
  return Math.min(100, Math.max(0, adjusted));
}

// ── News entry boost: can push a borderline signal over threshold ──────────
export function newsEntryBoost(currentScore: number, sentiment: NewsSentiment): number {
  if (sentiment.label === "strongly_positive") return currentScore + 2;
  if (sentiment.label === "moderately_positive") return currentScore + 1;
  return currentScore;
}
