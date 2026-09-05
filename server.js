import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

const appVersion = "1.0.0";

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const ALLOWED_PAIRS = new Set([
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD"
]);

const ALLOWED_INTERVALS = new Set([
  "1min",
  "5min",
  "15min",
  "30min",
  "45min",
  "1h",
  "2h",
  "4h",
  "8h",
  "1day",
  "1week",
  "1month"
]);

const MAX_OUTPUT_SIZE = 5000;

const CACHE_TTL_MS = 60 * 1000;

const cache = new Map();

/*
|--------------------------------------------------------------------------
| Security
|--------------------------------------------------------------------------
*/

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "100kb" }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many API requests. Please try again later."
  }
});

app.use("/api/", apiLimiter);

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

function isValidDate(value) {
  if (!value) {
    return false;
  }

  const d = new Date(value);

  return !Number.isNaN(d.getTime());
}

function normalizePair(pair) {
  return String(pair || "")
    .trim()
    .toUpperCase();
}

function normalizeInterval(interval) {
  return String(interval || "")
    .trim()
    .toLowerCase();
}

function parseNumber(value) {
  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}

function normalizeValues(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const result = [];

  for (const row of values) {
    if (!row) {
      continue;
    }

    const timestamp = new Date(`${row.datetime}Z`).getTime();

    const open = parseNumber(row.open);
    const high = parseNumber(row.high);
    const low = parseNumber(row.low);
    const close = parseNumber(row.close);

    if (!Number.isFinite(timestamp)) {
      continue;
    }

    if (
      open === null ||
      high === null ||
      low === null ||
      close === null
    ) {
      continue;
    }

    if (high < low) {
      continue;
    }

    if (open > high || open < low) {
      continue;
    }

    if (close > high || close < low) {
      continue;
    }

    result.push({
      time: Math.floor(timestamp / 1000),
      open,
      high,
      low,
      close
    });
  }

  /*
   * Twelve Data returns the newest values first.
   * Backtester requires chronological order.
   */
  result.sort((a, b) => a.time - b.time);

  /*
   * Remove duplicate timestamps.
   */
  const unique = [];

  let previousTime = null;

  for (const candle of result) {
    if (candle.time === previousTime) {
      continue;
    }

    unique.push(candle);

    previousTime = candle.time;
  }

  return unique;
}

function buildCacheKey({
  pair,
  interval,
  startDate,
  endDate,
  outputsize
}) {
  return [
    pair,
    interval,
    startDate || "",
    endDate || "",
    outputsize || ""
  ].join("|");
}

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: appVersion,
    provider: "twelve-data",
    automaticData: Boolean(TWELVE_DATA_API_KEY),
    timestamp: new Date().toISOString()
  });
});

/*
|--------------------------------------------------------------------------
| Available FX instruments
|--------------------------------------------------------------------------
*/

app.get("/api/fx/pairs", (req, res) => {
  res.json({
    ok: true,
    pairs: Array.from(ALLOWED_PAIRS)
  });
});

/*
|--------------------------------------------------------------------------
| Automatic FX historical data
|--------------------------------------------------------------------------
*/

app.get("/api/fx/candles", async (req, res) => {
  try {
    if (!TWELVE_DATA_API_KEY) {
      return res.status(503).json({
        ok: false,
        error:
          "Automatic data is not configured. Add TWELVE_DATA_API_KEY to Railway environment variables."
      });
    }

    const pair = normalizePair(req.query.pair);
    const interval = normalizeInterval(req.query.interval);

    const startDate = req.query.startDate
      ? String(req.query.startDate)
      : "";

    const endDate = req.query.endDate
      ? String(req.query.endDate)
      : "";

    let outputsize = Number(req.query.outputsize || 5000);

    if (!Number.isInteger(outputsize)) {
      outputsize = 5000;
    }

    outputsize = Math.max(
      1,
      Math.min(MAX_OUTPUT_SIZE, outputsize)
    );

    /*
     * Validate pair.
     */
    if (!ALLOWED_PAIRS.has(pair)) {
      return res.status(400).json({
        ok: false,
        error: "Unsupported FX pair."
      });
    }

    /*
     * Validate interval.
     */
    if (!ALLOWED_INTERVALS.has(interval)) {
      return res.status(400).json({
        ok: false,
        error: "Unsupported timeframe."
      });
    }

    /*
     * Validate dates if supplied.
     */
    if (startDate && !isValidDate(startDate)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid start date."
      });
    }

    if (endDate && !isValidDate(endDate)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid end date."
      });
    }

    /*
     * Prevent impossible date range.
     */
    if (
      startDate &&
      endDate &&
      new Date(startDate).getTime() >
        new Date(endDate).getTime()
    ) {
      return res.status(400).json({
        ok: false,
        error: "Start date must be before end date."
      });
    }

    const cacheKey = buildCacheKey({
      pair,
      interval,
      startDate,
      endDate,
      outputsize
    });

    /*
     * Cache.
     */
    const cached = cache.get(cacheKey);

    if (
      cached &&
      Date.now() - cached.timestamp < CACHE_TTL_MS
    ) {
      return res.json({
        ...cached.data,
        cached: true
      });
    }

    /*
     * Build Twelve Data URL.
     */
    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", pair);
    url.searchParams.set("interval", interval);
    url.searchParams.set("apikey", TWELVE_DATA_API_KEY);
    url.searchParams.set("format", "JSON");

    /*
     * If dates exist, use them.
     * Otherwise request outputsize.
     */
    if (startDate) {
      url.searchParams.set("start_date", startDate);
    }

    if (endDate) {
      url.searchParams.set("end_date", endDate);
    }

    if (!startDate && !endDate) {
      url.searchParams.set(
        "outputsize",
        String(outputsize)
      );
    }

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 15000);

    let response;

    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "Market data provider returned an error.",
        providerStatus: response.status
      });
    }

    if (data.status === "error") {
      return res.status(502).json({
        ok: false,
        error:
          data.message ||
          "Market data provider returned an error."
      });
    }

    const candles = normalizeValues(data.values);

    if (!candles.length) {
      return res.status(404).json({
        ok: false,
        error:
          "No valid OHLC data was returned for this request."
      });
    }

    const result = {
      ok: true,
      pair,
      interval,
      count: candles.length,
      candles,
      provider: "twelve-data",
      fetchedAt: new Date().toISOString(),
      cached: false
    };

    cache.set(cacheKey, {
      timestamp: Date.now(),
      data: result
    });

    /*
     * Basic cache cleanup.
     */
    if (cache.size > 100) {
      const oldestKey = cache.keys().next().value;

      if (oldestKey) {
        cache.delete(oldestKey);
      }
    }

    return res.json(result);
  } catch (error) {
    console.error("FX DATA ERROR:", error);

    if (error.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        error: "Market data request timed out."
      });
    }

    return res.status(500).json({
      ok: false,
      error: "Internal server error."
    });
  }
});

/*
|--------------------------------------------------------------------------
| Static frontend
|--------------------------------------------------------------------------
*/

app.use(
  express.static(__dirname, {
    index: "index.html",
    extensions: ["html"]
  })
);

/*
|--------------------------------------------------------------------------
| SPA fallback
|--------------------------------------------------------------------------
*/

app.get("*splat", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      ok: false,
      error: "API endpoint not found."
    });
  }

  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Trading Backtester server running on port ${PORT}`
  );

  console.log(
    `Automatic FX data: ${
      TWELVE_DATA_API_KEY
        ? "ENABLED"
        : "DISABLED"
    }`
  );
});
