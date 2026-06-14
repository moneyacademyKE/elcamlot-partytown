import { DataSource, DataSourceConfig, Bar } from "./datasource";

export interface Env {
  DB: D1Database;
  APCA_API_KEY_ID?: string;
  APCA_API_SECRET_KEY?: string;
  ALPHA_VANTAGE_API_KEY?: string;
}

const EQUITY_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "ADBE", "ADI", "ADP", "ADSK", "AEP", "ALNY", "AMAT",
  "AMD", "AMGN", "AMZN", "APP", "ARM", "ASML", "AVGO", "AXON", "BIIB", "BKNG",
  "BKR", "CDNS", "CEG", "CHTR", "CPRT", "CRWD", "CSCO", "CSGP", "CSX", "CTAS",
  "CTSH", "DASH", "DDOG", "DLTR", "DXCM", "EA", "EBAY", "ENPH", "EXC", "FANG",
  "FAST", "FTNT", "GEHC", "GILD", "GOOG", "GOOGL", "HON", "IDXX", "ILMN", "INCY",
  "INTC", "INTU", "ISRG", "KDP", "KHC", "KLAC", "LRCX", "LULU", "MAR", "MDB",
  "MDLZ", "MELI", "META", "MNST", "MRNA", "MRVL", "MU", "NFLX", "ODFL", "ON",
  "ORLY", "PANW", "PAYX", "PCAR", "PDD", "PEP", "PLTR", "PYPL", "QCOM", "REGN",
  "ROST", "SBUX", "SNPS", "TEAM", "TMUS", "TSLA", "TTWO", "TXN", "VEEV", "VICI",
  "VRSK", "VRTX", "WBA", "WBD", "WDAY", "WMT", "ZS", "SPY", "QQQ"
];
const CRYPTO_SYMBOLS = ["BTC/USD", "ETH/USD"];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Seed instruments on first fetch if needed
    await ensureInstrumentsSeeded(env.DB);

    // CORS headers for local testing
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // GET /api/instruments
    if (url.pathname === "/api/instruments") {
      const { results } = await env.DB.prepare(
        "SELECT * FROM instruments ORDER BY symbol ASC"
      ).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // GET /api/bars
    if (url.pathname === "/api/bars") {
      const instrumentId = url.searchParams.get("instrument_id");
      const timeframe = url.searchParams.get("timeframe") || "1D";

      if (!instrumentId) {
        return new Response(JSON.stringify({ error: "Missing instrument_id" }), {
          status: 400,
          headers: corsHeaders
        });
      }

      const { results } = await env.DB.prepare(
        "SELECT * FROM price_bars WHERE instrument_id = ? AND timeframe = ? ORDER BY time DESC LIMIT 365"
      )
      .bind(instrumentId, timeframe)
      .all();

      const bars = (results || []).reverse() as any[];

      // Calculate stats in TypeScript (unentangled from SQLite limits)
      const stats = calculateStats(bars);

      return new Response(
        JSON.stringify({
          bars,
          stats
        }),
        { headers: corsHeaders }
      );
    }

    // Ingestion Trigger Endpoint (for manual execution/testing)
    if (url.pathname === "/api/ingest") {
      const type = url.searchParams.get("type") || "crypto";
      const config: DataSourceConfig = {
        alpacaKeyId: env.APCA_API_KEY_ID || "",
        alpacaSecretKey: env.APCA_API_SECRET_KEY || "",
        alphaVantageKey: env.ALPHA_VANTAGE_API_KEY || ""
      };

      if (type === "crypto") {
        const count = await ingestCrypto(env.DB, config);
        return new Response(JSON.stringify({ status: "ok", type, count }), { headers: corsHeaders });
      } else {
        const count = await ingestEquities(env.DB, config);
        return new Response(JSON.stringify({ status: "ok", type, count }), { headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: corsHeaders
    });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await ensureInstrumentsSeeded(env.DB);

    const config: DataSourceConfig = {
      alpacaKeyId: env.APCA_API_KEY_ID || "",
      alpacaSecretKey: env.APCA_API_SECRET_KEY || "",
      alphaVantageKey: env.ALPHA_VANTAGE_API_KEY || ""
    };

    // Determine cron schedule trigger
    if (event.cron === "*/15 * * * *") {
      ctx.waitUntil(ingestCrypto(env.DB, config));
    } else {
      ctx.waitUntil(ingestEquities(env.DB, config));
    }
  }
};

async function ensureInstrumentsSeeded(db: D1Database) {
  const { results: existing } = await db.prepare("SELECT symbol FROM instruments").all();
  const existingSet = new Set((existing || []).map((x: any) => x.symbol));

  const batch = [];
  for (const sym of EQUITY_SYMBOLS) {
    if (!existingSet.has(sym)) {
      batch.push(
        db.prepare(
          "INSERT INTO instruments (symbol, asset_class) VALUES (?, 'us_equity')"
        ).bind(sym)
      );
    }
  }
  for (const sym of CRYPTO_SYMBOLS) {
    if (!existingSet.has(sym)) {
      batch.push(
        db.prepare(
          "INSERT INTO instruments (symbol, asset_class) VALUES (?, 'crypto')"
        ).bind(sym)
      );
    }
  }

  if (batch.length > 0) {
    console.log(`Seeding ${batch.length} new instruments into Cloudflare D1...`);
    await db.batch(batch);
  }
}

async function ingestCrypto(db: D1Database, config: DataSourceConfig): Promise<number> {
  console.log("Ingesting Crypto price bars (15Min timeframe)...");
  let totalSaved = 0;

  for (const symbol of CRYPTO_SYMBOLS) {
    try {
      const inst = await db.prepare("SELECT id FROM instruments WHERE symbol = ?").bind(symbol).first<any>();
      if (!inst) continue;

      const bars = await DataSource.fetchCryptoBarsWithFallback(symbol, config);
      const batch = [];
      for (const bar of bars) {
        batch.push(
          db.prepare(`
            INSERT INTO price_bars (time, open_cents, high_cents, low_cents, close_cents, volume, timeframe, instrument_id)
            VALUES (?, ?, ?, ?, ?, ?, '15Min', ?)
            ON CONFLICT(instrument_id, timeframe, time) DO NOTHING
          `).bind(
            bar.timestamp,
            Math.round(bar.open * 100),
            Math.round(bar.high * 100),
            Math.round(bar.low * 100),
            Math.round(bar.close * 100),
            bar.volume,
            inst.id
          )
        );
      }
      if (batch.length > 0) {
        await db.batch(batch);
        totalSaved += batch.length;
        console.log(`Crypto Ingestion: stored ${batch.length} bars for ${symbol}`);
      }
    } catch (err: any) {
      console.error(`Failed to ingest crypto ${symbol}: ${err.message}`);
    }
  }
  return totalSaved;
}

async function ingestEquities(db: D1Database, config: DataSourceConfig): Promise<number> {
  console.log("Ingesting Equity price bars (1D timeframe)...");
  let totalSaved = 0;
  const start = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().split("T")[0]; // Last 5 days

  for (const symbol of EQUITY_SYMBOLS) {
    try {
      const inst = await db.prepare("SELECT id FROM instruments WHERE symbol = ?").bind(symbol).first<any>();
      if (!inst) continue;

      const bars = await DataSource.fetchBarsWithFallback(symbol, start, config);
      const batch = [];
      for (const bar of bars) {
        batch.push(
          db.prepare(`
            INSERT INTO price_bars (time, open_cents, high_cents, low_cents, close_cents, volume, timeframe, instrument_id)
            VALUES (?, ?, ?, ?, ?, ?, '1D', ?)
            ON CONFLICT(instrument_id, timeframe, time) DO NOTHING
          `).bind(
            bar.timestamp,
            Math.round(bar.open * 100),
            Math.round(bar.high * 100),
            Math.round(bar.low * 100),
            Math.round(bar.close * 100),
            bar.volume,
            inst.id
          )
        );
      }
      if (batch.length > 0) {
        await db.batch(batch);
        totalSaved += batch.length;
        console.log(`Equity Ingestion: stored ${batch.length} bars for ${symbol}`);
      }
    } catch (err: any) {
      console.error(`Failed to ingest equity ${symbol}: ${err.message}`);
    }
  }
  return totalSaved;
}

function calculateStats(bars: any[]) {
  if (bars.length === 0) {
    return {
      count: 0,
      avg_price: 0,
      min_price: 0,
      max_price: 0,
      std_dev: 0,
      median: 0,
      first_bar: null,
      last_bar: null
    };
  }

  const closePrices = bars.map(b => b.close_cents);
  const count = closePrices.length;
  const sum = closePrices.reduce((a, b) => a + b, 0);
  const avg = Math.round(sum / count);
  const min = Math.min(...closePrices);
  const max = Math.max(...closePrices);

  // Median
  const sorted = [...closePrices].sort((a, b) => a - b);
  const mid = Math.floor(count / 2);
  const median = count % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

  // Standard Deviation
  const variance = closePrices.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / count;
  const stdDev = Math.round(Math.sqrt(variance));

  return {
    count,
    avg_price: avg,
    min_price: min,
    max_price: max,
    std_dev: stdDev,
    median,
    first_bar: bars[0].time,
    last_bar: bars[count - 1].time
  };
}
