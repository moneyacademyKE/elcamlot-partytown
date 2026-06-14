export interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DataSourceConfig {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  alphaVantageKey: string;
}

export class AlpacaSource {
  static async fetchBars(symbol: string, start: string, config: DataSourceConfig): Promise<Bar[]> {
    if (!config.alpacaKeyId || !config.alpacaSecretKey) {
      throw new Error("Alpaca credentials missing");
    }

    const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&start=${start}&limit=100`;
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": config.alpacaKeyId,
        "APCA-API-SECRET-KEY": config.alpacaSecretKey
      }
    });

    if (!res.ok) {
      throw new Error(`Alpaca API error: ${res.status} ${await res.text()}`);
    }

    const data: any = await res.json();
    const bars = data.bars?.[symbol] || [];
    return bars.map((b: any) => ({
      timestamp: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v
    }));
  }

  static async fetchCryptoBars(symbol: string, config: DataSourceConfig): Promise<Bar[]> {
    if (!config.alpacaKeyId || !config.alpacaSecretKey) {
      throw new Error("Alpaca credentials missing");
    }

    // Alpaca expects crypto symbols without "/" (e.g. BTC/USD -> BTCUSD)
    const alpacaSymbol = symbol.replace("/", "");
    const start = new Date(Date.now() - 3600 * 1000).toISOString(); // Fetch last hour
    const url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${alpacaSymbol}&timeframe=15Min&start=${start}&limit=10`;

    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": config.alpacaKeyId,
        "APCA-API-SECRET-KEY": config.alpacaSecretKey
      }
    });

    if (!res.ok) {
      throw new Error(`Alpaca Crypto API error: ${res.status} ${await res.text()}`);
    }

    const data: any = await res.json();
    const bars = data.bars?.[alpacaSymbol] || [];
    return bars.map((b: any) => ({
      timestamp: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v
    }));
  }
}

export class AlphaVantageSource {
  static async fetchBars(symbol: string, config: DataSourceConfig): Promise<Bar[]> {
    if (!config.alphaVantageKey || config.alphaVantageKey === "mock") {
      console.log(`AlphaVantageSource: Using mock bar data for ${symbol}`);
      return this.generateMockBars(symbol);
    }

    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${config.alphaVantageKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Alpha Vantage API error: ${res.status}`);
    }

    const data: any = await res.json();
    if (data["Note"]) {
      throw new Error(`Alpha Vantage Rate Limit: ${data["Note"]}`);
    }
    if (data["Error Message"]) {
      throw new Error(`Alpha Vantage Error: ${data["Error Message"]}`);
    }

    const series = data["Time Series (Daily)"] || {};
    return Object.entries(series).map(([date, bar]: [string, any]) => ({
      timestamp: new Date(`${date}T00:00:00Z`).toISOString(),
      open: parseFloat(bar["1. open"]),
      high: parseFloat(bar["2. high"]),
      low: parseFloat(bar["3. low"]),
      close: parseFloat(bar["4. close"]),
      volume: parseInt(bar["5. volume"], 10)
    })).reverse();
  }

  static async fetchCryptoBars(symbol: string, config: DataSourceConfig): Promise<Bar[]> {
    if (!config.alphaVantageKey || config.alphaVantageKey === "mock") {
      console.log(`AlphaVantageSource: Using mock crypto bar data for ${symbol}`);
      return this.generateMockBars(symbol);
    }

    const [coin, market = "USD"] = symbol.split("/");
    const url = `https://www.alphavantage.co/query?function=DIGITAL_CURRENCY_DAILY&symbol=${coin}&market=${market}&apikey=${config.alphaVantageKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Alpha Vantage API error: ${res.status}`);
    }

    const data: any = await res.json();
    if (data["Note"]) {
      throw new Error(`Alpha Vantage Rate Limit: ${data["Note"]}`);
    }
    if (data["Error Message"]) {
      throw new Error(`Alpha Vantage Error: ${data["Error Message"]}`);
    }

    const series = data["Time Series (Digital Currency Daily)"] || {};
    return Object.entries(series).map(([date, bar]: [string, any]) => ({
      timestamp: new Date(`${date}T00:00:00Z`).toISOString(),
      open: parseFloat(bar[`1a. open (${market})`]),
      high: parseFloat(bar[`2a. high (${market})`]),
      low: parseFloat(bar[`3a. low (${market})`]),
      close: parseFloat(bar[`4a. close (${market})`]),
      volume: parseFloat(bar["5. volume"])
    })).reverse();
  }

  private static generateMockBars(symbol: string): Bar[] {
    const bars: Bar[] = [];
    const basePrice = symbol.includes("BTC") ? 64000 : symbol.includes("ETH") ? 3400 : 150;
    const now = Date.now();
    const isCrypto = symbol.includes("/");
    const intervalMs = isCrypto ? 15 * 60 * 1000 : 24 * 3600 * 1000;
    const count = isCrypto ? 10 : 30;

    for (let i = count; i >= 0; i--) {
      const time = new Date(now - i * intervalMs).toISOString();
      const variance = (Math.random() - 0.5) * (basePrice * 0.02);
      bars.push({
        timestamp: time,
        open: basePrice + variance - (Math.random() - 0.5) * 5,
        high: basePrice + variance + Math.random() * 10,
        low: basePrice + variance - Math.random() * 10,
        close: basePrice + variance,
        volume: Math.floor(1000 + Math.random() * 5000)
      });
    }
    return bars;
  }
}

export class DataSource {
  static async fetchBarsWithFallback(symbol: string, start: string, config: DataSourceConfig): Promise<Bar[]> {
    try {
      console.log(`DataSource fallback: Querying AlpacaSource for ${symbol}`);
      return await AlpacaSource.fetchBars(symbol, start, config);
    } catch (err: any) {
      console.warn(`DataSource fallback: AlpacaSource failed for ${symbol} with: ${err.message}`);
      console.log(`DataSource fallback: Querying AlphaVantageSource for ${symbol}`);
      return await AlphaVantageSource.fetchBars(symbol, config);
    }
  }

  static async fetchCryptoBarsWithFallback(symbol: string, config: DataSourceConfig): Promise<Bar[]> {
    try {
      console.log(`DataSource fallback: Querying AlpacaSource for ${symbol}`);
      return await AlpacaSource.fetchCryptoBars(symbol, config);
    } catch (err: any) {
      console.warn(`DataSource fallback: AlpacaSource failed for ${symbol} with: ${err.message}`);
      console.log(`DataSource fallback: Querying AlphaVantageSource for ${symbol}`);
      return await AlphaVantageSource.fetchCryptoBars(symbol, config);
    }
  }
}
