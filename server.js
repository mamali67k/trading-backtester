import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || "";

const TWELVE_DATA_URL = "https://api.twelvedata.com/time_series";

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_OUTPUT_SIZE = 5000;

const cache = new Map();

const ALLOWED_PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD"
];

const ALLOWED_INTERVALS = [
  "1min",
  "5min",
  "15min",
  "30min",
  "1h",
  "2h",
  "4h",
  "8h",
  "1day"
];

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "100kb" }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "Too many API requests. Please try again later."
  }
});

app.use("/api/", apiLimiter);

/* =========================================================
   HELPERS
   ========================================================= */

function cleanString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function parseOutputSize(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return 5000;
  }

  return Math.min(Math.max(parsed, 1), MAX_OUTPUT_SIZE);
}

function isValidPair(pair) {
  return ALLOWED_PAIRS.includes(pair);
}

function isValidInterval(interval) {
  return ALLOWED_INTERVALS.includes(interval);
}

function buildCacheKey({
  pair,
  interval,
  outputsize,
  startDate,
  endDate
}) {
  return [
    pair,
    interval,
    outputsize,
    startDate || "",
    endDate || ""
  ].join("|");
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 100000000000) {
      return Math.floor(value / 1000);
    }

    return Math.floor(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const text = value.trim();

  if (!text) {
    return null;
  }

  const numeric = Number(text);

  if (Number.isFinite(numeric)) {
    if (numeric > 100000000000) {
      return Math.floor(numeric / 1000);
    }

    return Math.floor(numeric);
  }

  const timestamp = Date.parse(text);

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.floor(timestamp / 1000);
}

function parseNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return null;
  }

  return number;
}

function validateAndNormalizeCandles(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  const candles = [];

  for (const item of values) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const time = parseTimestamp(item.datetime);

    const open = parseNumber(item.open);
    const high = parseNumber(item.high);
    const low = parseNumber(item.low);
    const close = parseNumber(item.close);

    if (
      time === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null
    ) {
      continue;
    }

    if (
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0
    ) {
      continue;
    }

    if (high < low) {
      continue;
    }

    if (high < open || high < close) {
      continue;
    }

    if (low > open || low > close) {
      continue;
    }

    candles.push({
      time,
      open,
      high,
      low,
      close
    });
  }

  candles.sort((a, b) => a.time - b.time);

  const unique = [];
  let previousTime = null;

  for (const candle of candles) {
    if (candle.time === previousTime) {
      continue;
    }

    unique.push(candle);
    previousTime = candle.time;
  }

  return unique;
}

function getCache(key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

function setCache(key, data) {
  cache.set(key, {
    timestamp: Date.now(),
    data
  });
}

function cleanupCache() {
  const now = Date.now();

  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "trading-backtester",
    automaticData: Boolean(TWELVE_DATA_API_KEY),
    provider: "twelve_data",
    cache: true,
    cacheTtlMinutes: CACHE_TTL_MS / 60000,
    node: process.version,
    time: new Date().toISOString()
  });
});

/* =========================================================
   API TEST
   ========================================================= */

app.get("/api/test", (req, res) => {
  res.json({
    ok: true,
    message: "API endpoint is working.",
    time: new Date().toISOString()
  });
});

/* =========================================================
   FX PAIRS
   ========================================================= */

app.get("/api/fx/pairs", (req, res) => {
  res.json({
    ok: true,
    pairs: ALLOWED_PAIRS
  });
});

/* =========================================================
   TWELVE DATA FETCH
   ========================================================= */

async function fetchFromTwelveData({
  pair,
  interval,
  outputsize,
  startDate,
  endDate
}) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is not configured on the server."
    );
  }

  const params = new URLSearchParams();

  params.set("symbol", pair);
  params.set("interval", interval);
  params.set("outputsize", String(outputsize));
  params.set("apikey", TWELVE_DATA_API_KEY);
  params.set("format", "JSON");
  params.set("order", "ASC");

  if (startDate) {
    params.set("start_date", startDate);
  }

  if (endDate) {
    params.set("end_date", endDate);
  }

  const url = `${TWELVE_DATA_URL}?${params.toString()}`;

  console.log(
    "FX DATA REQUEST:",
    JSON.stringify({
      pair,
      interval,
      outputsize,
      startDate: startDate || null,
      endDate: endDate || null
    })
  );

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 30000);

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        "Twelve Data request timed out."
      );
    }

    throw new Error(
      `Unable to connect to Twelve Data: ${error.message}`
    );
  } finally {
    clearTimeout(timeout);
  }

  let data;

  try {
    data = await response.json();
  } catch (error) {
    throw new Error(
      "Twelve Data returned an invalid JSON response."
    );
  }

  if (!response.ok) {
    const providerMessage =
      data?.message ||
      data?.code ||
      `HTTP ${response.status}`;

    throw new Error(
      `Twelve Data request failed: ${providerMessage}`
    );
  }

  if (data?.status === "error") {
    throw new Error(
      data?.message ||
      "Twelve Data returned an error."
    );
  }

  if (!Array.isArray(data?.values)) {
    throw new Error(
      data?.message ||
      "Twelve Data returned no candle data."
    );
  }

  const candles =
    validateAndNormalizeCandles(data.values);

  if (candles.length === 0) {
    throw new Error(
      "No valid OHLC candles were returned."
    );
  }

  return candles;
}

/* =========================================================
   MAIN FX CANDLES ENDPOINT
   ========================================================= */

app.get("/api/fx/base-candles", async (req, res) => {
  try {
    const pair =
      cleanString(req.query.pair) || "EUR/USD";

    const interval =
      cleanString(req.query.interval) || "1min";

    const outputsize =
      parseOutputSize(req.query.outputsize);

    const startDate =
      cleanString(req.query.startDate) ||
      cleanString(req.query.start_date);

    const endDate =
      cleanString(req.query.endDate) ||
      cleanString(req.query.end_date);

    if (!isValidPair(pair)) {
      return res.status(400).json({
        ok: false,
        error: "Unsupported FX pair.",
        allowedPairs: ALLOWED_PAIRS
      });
    }

    if (!isValidInterval(interval)) {
      return res.status(400).json({
        ok: false,
        error: "Unsupported timeframe.",
        allowedIntervals: ALLOWED_INTERVALS
      });
    }

    if (startDate && Number.isNaN(Date.parse(startDate))) {
      return res.status(400).json({
        ok: false,
        error: "Invalid startDate."
      });
    }

    if (endDate && Number.isNaN(Date.parse(endDate))) {
      return res.status(400).json({
        ok: false,
        error: "Invalid endDate."
      });
    }

    if (startDate && endDate) {
      if (Date.parse(startDate) > Date.parse(endDate)) {
        return res.status(400).json({
          ok: false,
          error: "startDate must be before endDate."
        });
      }
    }

    const cacheKey = buildCacheKey({
      pair,
      interval,
      outputsize,
      startDate,
      endDate
    });

    const cached = getCache(cacheKey);

    if (cached) {
      console.log(
        "CACHE HIT:",
        JSON.stringify({
          pair,
          interval,
          count: cached.length
        })
      );

      return res.json({
        ok: true,
        pair,
        interval,
        count: cached.length,
        candles: cached,
        source: "twelve_data",
        cached: true,
        time: new Date().toISOString()
      });
    }

    const candles = await fetchFromTwelveData({
      pair,
      interval,
      outputsize,
      startDate,
      endDate
    });

    setCache(cacheKey, candles);

    console.log(
      "SUCCESS:",
      JSON.stringify({
        pair,
        interval,
        count: candles.length,
        cached: false
      })
    );

    return res.json({
      ok: true,
      pair,
      interval,
      count: candles.length,
      candles,
      source: "twelve_data",
      cached: false,
      time: new Date().toISOString()
    });
  } catch (error) {
    console.error(
      "FX DATA ERROR:",
      error.message
    );

    return res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});

/* =========================================================
   API 404
   ========================================================= */

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "API endpoint not found.",
    path: req.originalUrl
  });
});

/* =========================================================
   STATIC FRONTEND
   ========================================================= */

app.use(
  express.static(__dirname, {
    index: "index.html"
  })
);

/* =========================================================
   FRONTEND FALLBACK
   ========================================================= */

app.use((req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return next();
  }

  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use((error, req, res, next) => {
  console.error(
    "SERVER ERROR:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: "Internal server error."
  });
});

/* =========================================================
   CACHE CLEANUP
   ========================================================= */

setInterval(
  cleanupCache,
  15 * 60 * 1000
).unref();

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("========================================");
  console.log("TRADING BACKTESTER SERVER");
  console.log("========================================");
  console.log(`PORT: ${PORT}`);
  console.log(
    `AUTOMATIC DATA: ${
      TWELVE_DATA_API_KEY
        ? "ENABLED"
        : "DISABLED - API KEY MISSING"
    }`
  );
  console.log("CACHE: ENABLED");
  console.log(
    `CACHE TTL: ${CACHE_TTL_MS / 60000} minutes`
  );
  console.log("PROVIDER: Twelve Data");
  console.log("========================================");
  console.log("");
});
