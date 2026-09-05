import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json({ limit: "100kb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

app.use("/api/", limiter);


/*
|--------------------------------------------------------------------------
| FX PAIRS
|--------------------------------------------------------------------------
*/

const PAIRS = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD"
];


/*
|--------------------------------------------------------------------------
| IMPORTANT
|
| The server always downloads ONE BASE TIMEFRAME.
|
| Frontend creates:
|
| 1m
| 5m
| 15m
| 30m
| 1h
| 4h
| 1d
|
| locally.
|--------------------------------------------------------------------------
*/

const BASE_INTERVAL = "1min";

const MAX_CANDLES = 5000;

const CACHE_TTL = 60 * 60 * 1000;

const cache = new Map();


/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {

  res.json({
    ok: true,
    automaticData: Boolean(API_KEY),
    baseInterval: BASE_INTERVAL,
    pairs: PAIRS,
    timestamp: new Date().toISOString()
  });

});


/*
|--------------------------------------------------------------------------
| PAIRS
|--------------------------------------------------------------------------
*/

app.get("/api/fx/pairs", (req, res) => {

  res.json({
    ok: true,
    pairs: PAIRS
  });

});


/*
|--------------------------------------------------------------------------
| VALIDATION
|--------------------------------------------------------------------------
*/

function validPair(pair) {

  return PAIRS.includes(pair);

}


function number(value) {

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;

}


/*
|--------------------------------------------------------------------------
| NORMALIZE
|--------------------------------------------------------------------------
*/

function normalize(values) {

  if (!Array.isArray(values)) {

    return [];

  }

  const result = [];

  for (const row of values) {

    const time = new Date(
      `${row.datetime}Z`
    ).getTime();

    const open = number(row.open);
    const high = number(row.high);
    const low = number(row.low);
    const close = number(row.close);

    if (!Number.isFinite(time)) {
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

    if (
      high < low ||
      open < low ||
      open > high ||
      close < low ||
      close > high
    ) {

      continue;

    }

    result.push({
      time: Math.floor(time / 1000),
      open,
      high,
      low,
      close
    });

  }


  result.sort(
    (a, b) =>
      a.time - b.time
  );


  const unique = [];

  let last = null;

  for (const candle of result) {

    if (candle.time === last) {
      continue;
    }

    unique.push(candle);

    last = candle.time;

  }

  return unique;

}


/*
|--------------------------------------------------------------------------
| CACHE KEY
|--------------------------------------------------------------------------
*/

function cacheKey(
  pair,
  startDate,
  endDate,
  outputsize
) {

  return [
    pair,
    startDate || "",
    endDate || "",
    outputsize
  ].join("|");

}


/*
|--------------------------------------------------------------------------
| BASE DATA API
|--------------------------------------------------------------------------
*/

app.get(
  "/api/fx/base-candles",
  async (req, res) => {

    try {

      if (!API_KEY) {

        return res.status(503).json({
          ok: false,
          error:
            "TWELVE_DATA_API_KEY is not configured."
        });

      }


      const pair =
        String(
          req.query.pair || ""
        )
        .trim()
        .toUpperCase();


      if (!validPair(pair)) {

        return res.status(400).json({
          ok: false,
          error:
            "Unsupported FX pair."
        });

      }


      const startDate =
        req.query.startDate
          ? String(req.query.startDate)
          : "";


      const endDate =
        req.query.endDate
          ? String(req.query.endDate)
          : "";


      let outputsize =
        Number(
          req.query.outputsize || MAX_CANDLES
        );


      if (
        !Number.isInteger(outputsize)
      ) {

        outputsize = MAX_CANDLES;

      }


      outputsize =
        Math.max(
          1,
          Math.min(
            MAX_CANDLES,
            outputsize
          )
        );


      const key =
        cacheKey(
          pair,
          startDate,
          endDate,
          outputsize
        );


      const cached =
        cache.get(key);


      if (
        cached &&
        Date.now() -
          cached.createdAt <
          CACHE_TTL
      ) {

        return res.json({
          ...cached.data,
          cached: true
        });

      }


      const url =
        new URL(
          "https://api.twelvedata.com/time_series"
        );


      url.searchParams.set(
        "symbol",
        pair
      );


      url.searchParams.set(
        "interval",
        BASE_INTERVAL
      );


      url.searchParams.set(
        "apikey",
        API_KEY
      );


      url.searchParams.set(
        "format",
        "JSON"
      );


      if (startDate) {

        url.searchParams.set(
          "start_date",
          startDate
        );

      }


      if (endDate) {

        url.searchParams.set(
          "end_date",
          endDate
        );

      }


      if (
        !startDate &&
        !endDate
      ) {

        url.searchParams.set(
          "outputsize",
          String(outputsize)
        );

      }


      const controller =
        new AbortController();


      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          15000
        );


      let response;

      try {

        response =
          await fetch(
            url,
            {
              method: "GET",
              headers: {
                Accept:
                  "application/json"
              },
              signal:
                controller.signal
            }
          );

      } finally {

        clearTimeout(timeout);

      }


      const data =
        await response.json();


      if (!response.ok) {

        return res.status(502).json({
          ok: false,
          error:
            "Market provider request failed."
        });

      }


      if (
        data.status === "error"
      ) {

        return res.status(502).json({
          ok: false,
          error:
            data.message ||
            "Market provider returned an error."
        });

      }


      const candles =
        normalize(
          data.values
        );


      if (!candles.length) {

        return res.status(404).json({
          ok: false,
          error:
            "No valid market data."
        });

      }


      const result = {
        ok: true,

        pair,

        baseInterval:
          BASE_INTERVAL,

        count:
          candles.length,

        candles,

        provider:
          "twelve-data",

        fetchedAt:
          new Date().toISOString(),

        cached: false
      };


      cache.set(
        key,
        {
          createdAt:
            Date.now(),

          data:
            result
        }
      );


      return res.json(
        result
      );


    } catch (error) {

      console.error(
        "BASE DATA ERROR:",
        error
      );


      if (
        error.name ===
        "AbortError"
      ) {

        return res.status(504).json({
          ok: false,
          error:
            "Market data request timed out."
        });

      }


      return res.status(500).json({
        ok: false,
        error:
          "Internal server error."
      });

    }

  }
);


/*
|--------------------------------------------------------------------------
| STATIC FILES
|--------------------------------------------------------------------------
*/

app.use(
  express.static(
    __dirname,
    {
      index: "index.html"
    }
  )
);


/*
|--------------------------------------------------------------------------
| SPA FALLBACK
|--------------------------------------------------------------------------
*/

app.get(
  "*splat",
  (req, res) => {

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {

      return res.status(404).json({
        ok: false,
        error:
          "API endpoint not found."
      });

    }


    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );

  }
);


/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `Trading Backtester running on ${PORT}`
    );

    console.log(
      `Base market interval: ${BASE_INTERVAL}`
    );

    console.log(
      `Automatic data: ${
        API_KEY
          ? "ENABLED"
          : "DISABLED"
      }`
    );

  }
);
