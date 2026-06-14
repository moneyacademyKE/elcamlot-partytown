CREATE TABLE IF NOT EXISTS instruments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT UNIQUE NOT NULL,
  name TEXT,
  asset_class TEXT NOT NULL,
  exchange TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_bars (
  time TEXT NOT NULL,
  open_cents INTEGER NOT NULL,
  high_cents INTEGER NOT NULL,
  low_cents INTEGER NOT NULL,
  close_cents INTEGER NOT NULL,
  volume INTEGER DEFAULT 0,
  timeframe TEXT NOT NULL,
  instrument_id INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  PRIMARY KEY (instrument_id, timeframe, time)
);
