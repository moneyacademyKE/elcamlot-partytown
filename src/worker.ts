import { DataSource, DataSourceConfig, Bar } from "./datasource";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
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
    
    // Seed instruments on first fetch
    await ensureInstrumentsSeeded(env.DB);

    // CORS headers
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

      // Query D1 (Hot cache: holds last 10 days of bars)
      const { results } = await env.DB.prepare(
        "SELECT * FROM price_bars WHERE instrument_id = ? AND timeframe = ? ORDER BY time DESC LIMIT 365"
      )
      .bind(instrumentId, timeframe)
      .all();

      const bars = (results || []).reverse() as any[];
      const stats = calculateStats(bars);

      return new Response(
        JSON.stringify({
          bars,
          stats
        }),
        { headers: corsHeaders }
      );
    }

    // GET /api/historical/file/:key (Streams the quarterly consolidated file)
    if (url.pathname.startsWith("/api/historical/file/")) {
      const parts = url.pathname.split("/");
      const key = decodeURIComponent(parts[parts.length - 1]);
      const object = await env.BUCKET.get(key);

      if (!object) {
        return new Response(JSON.stringify({ error: "File not found in R2" }), {
          status: 404,
          headers: corsHeaders
        });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Content-Type", "application/octet-stream");
      return new Response(object.body, { headers });
    }

    // GET /api/historical/:symbol (Returns list of available consolidated files)
    if (url.pathname.startsWith("/api/historical/")) {
      const parts = url.pathname.split("/");
      const symbol = decodeURIComponent(parts[parts.length - 1]);
      const symbolPrefix = `${symbol.replace("/", "_")}-`;

      const list = await env.BUCKET.list({ prefix: symbolPrefix });
      const files = list.objects
        .filter(obj => obj.key.endsWith(".parquet"))
        .map(obj => ({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded
        }));

      return new Response(JSON.stringify(files), { headers: corsHeaders });
    }

    // GET /api/ingest
    if (url.pathname === "/api/ingest") {
      const type = url.searchParams.get("type") || "crypto";
      const config: DataSourceConfig = {
        alpacaKeyId: env.APCA_API_KEY_ID || "",
        alpacaSecretKey: env.APCA_API_SECRET_KEY || "",
        alphaVantageKey: env.ALPHA_VANTAGE_API_KEY || ""
      };

      let count = 0;
      if (type === "crypto") {
        count = await ingestCrypto(env.DB, config);
      } else {
        count = await ingestEquities(env.DB, config);
      }

      // Trigger automatic R2 archiving cycle (moves data older than 10 days to R2)
      const archivedCount = await archiveToR2(env.DB, env.BUCKET);

      return new Response(JSON.stringify({ status: "ok", type, count, archivedCount }), { headers: corsHeaders });
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

    if (event.cron === "*/15 * * * *") {
      ctx.waitUntil(
        ingestCrypto(env.DB, config).then(() => archiveToR2(env.DB, env.BUCKET))
      );
    } else {
      ctx.waitUntil(
        ingestEquities(env.DB, config).then(() => archiveToR2(env.DB, env.BUCKET))
      );
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
  console.log("Ingesting Crypto price bars...");
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
      }
    } catch (err: any) {
      console.error(`Failed to ingest crypto ${symbol}: ${err.message}`);
    }
  }
  return totalSaved;
}

async function ingestEquities(db: D1Database, config: DataSourceConfig): Promise<number> {
  console.log("Ingesting Equity price bars...");
  let totalSaved = 0;
  // Fetch a larger window for initial seeding, but D1 will prune older data during archiving
  const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split("T")[0]; // Last 30 days

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
      }
    } catch (err: any) {
      console.error(`Failed to ingest equity ${symbol}: ${err.message}`);
    }
  }
  return totalSaved;
}

// D1-to-R2 Archiving Pipeline (Consolidates quarterly)
async function archiveToR2(db: D1Database, bucket: R2Bucket): Promise<number> {
  const retentionCutoff = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  console.log(`R2 Archiving: Querying records older than 10 days (${retentionCutoff})...`);

  const { results: instruments } = await db.prepare("SELECT * FROM instruments").all();
  let totalArchived = 0;

  for (const inst of (instruments || []) as any[]) {
    const { results } = await db.prepare(
      "SELECT * FROM price_bars WHERE instrument_id = ? AND time < ?"
    )
    .bind(inst.id, retentionCutoff)
    .all();

    const oldBars = (results || []) as any[];

    if (oldBars.length > 0) {
      // Group by year-quarter
      const groups: Record<string, any[]> = {};
      for (const bar of oldBars) {
        const datePart = bar.time.split(" ")[0] || bar.time.split("T")[0] || "";
        const year = datePart.split("-")[0] || "2026";
        const month = parseInt(datePart.split("-")[1] || "1", 10);
        const quarter = Math.floor((month - 1) / 3) + 1;
        const groupKey = `${year}-Q${quarter}`;

        if (!groups[groupKey]) {
          groups[groupKey] = [];
        }
        groups[groupKey].push(bar);
      }

      for (const [groupKey, bars] of Object.entries(groups)) {
        const fileKey = `${inst.symbol.replace("/", "_")}-${groupKey}.parquet`;
        console.log(`Archiving ${bars.length} bars for ${inst.symbol} to R2 (${fileKey})...`);

        let mergedBars = [...bars];
        const existingObject = await bucket.get(fileKey);
        if (existingObject) {
          try {
            const existingText = await existingObject.text();
            const existingData = JSON.parse(existingText);
            if (Array.isArray(existingData)) {
              const seenTimes = new Set(mergedBars.map(b => b.time));
              for (const b of existingData) {
                if (!seenTimes.has(b.time)) {
                  mergedBars.push(b);
                }
              }
            }
          } catch (e) {
            console.warn(`Failed to parse existing archive ${fileKey}:`, e);
          }
        }

        mergedBars.sort((a, b) => a.time.localeCompare(b.time));

        await bucket.put(fileKey, JSON.stringify(mergedBars), {
          httpMetadata: { contentType: "application/octet-stream" }
        });
      }

      // Purge archived rows from D1
      const { meta } = await db.prepare(
        "DELETE FROM price_bars WHERE instrument_id = ? AND time < ?"
      )
      .bind(inst.id, retentionCutoff)
      .run();

      totalArchived += meta.changes || oldBars.length;
      console.log(`Purged ${meta.changes} archived rows from D1 for ${inst.symbol}`);
    }
  }

  return totalArchived;
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

  const sorted = [...closePrices].sort((a, b) => a - b);
  const mid = Math.floor(count / 2);
  const median = count % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);

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
