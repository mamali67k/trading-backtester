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


/*
|--------------------------------------------------------------------------
| RATE LIMIT
|--------------------------------------------------------------------------
*/

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", apiLimiter);


/*
|--------------------------------------------------------------------------
| SUPPORTED PAIRS
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
| BASE DATA
|--------------------------------------------------------------------------
*/

const BASE_INTERVAL = "1min";

const MAX_CANDLES = 5000;


/*
|--------------------------------------------------------------------------
| CACHE
|--------------------------------------------------------------------------
*/

const cache = new Map();

const CACHE_TTL = 60 * 60 * 1000;


/*
|--------------------------------------------------------------------------
| ROOT TEST
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "index.html"
    )
  );

});


/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/api/health", (req, res) => {

  res.json({

    ok: true,

    server: "Trading Backtester",

    automaticData:
      Boolean(API_KEY),

    baseInterval:
      BASE_INTERVAL,

    pairs:
      PAIRS,

    time:
      new Date().toISOString()

  });

});


/*
|--------------------------------------------------------------------------
| API TEST
|--------------------------------------------------------------------------
*/

app.get("/api/test", (req, res) => {

  res.json({

    ok: true,

    message:
      "API endpoint is working.",

    time:
      new Date().toISOString()

  });

});


/*
|--------------------------------------------------------------------------
| FX PAIRS
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
| NUMBER
|--------------------------------------------------------------------------
*/

function toNumber(value) {

  const result =
    Number(value);

  if (
    Number.isFinite(result)
  ) {

    return result;

  }

  return null;

}


/*
|--------------------------------------------------------------------------
| NORMALIZE PROVIDER DATA
|--------------------------------------------------------------------------
*/

function normalizeCandles(values) {

  if (
    !Array.isArray(values)
  ) {

    return [];

  }


  const candles = [];


  for (
    const row of values
  ) {

    if (
      !row.datetime
    ) {

      continue;

    }


    const timestamp =
      new Date(
        `${row.datetime}Z`
      ).getTime();


    const open =
      toNumber(row.open);

    const high =
      toNumber(row.high);

    const low =
      toNumber(row.low);

    const close =
      toNumber(row.close);


    if (
      !Number.isFinite(
        timestamp
      )
    ) {

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
      high < low
    ) {

      continue;

    }


    if (
      open < low ||
      open > high
    ) {

      continue;

    }


    if (
      close < low ||
      close > high
    ) {

      continue;

    }


    candles.push({

      time:
        Math.floor(
          timestamp / 1000
        ),

      open,

      high,

      low,

      close

    });

  }


  candles.sort(
    (a, b) =>
      a.time - b.time
  );


  /*
   * Remove duplicates.
   */

  const unique = [];

  let lastTime = null;


  for (
    const candle of candles
  ) {

    if (
      candle.time ===
      lastTime
    ) {

      continue;

    }


    unique.push(
      candle
    );

    lastTime =
      candle.time;

  }


  return unique;

}


/*
|--------------------------------------------------------------------------
| API CACHE
|--------------------------------------------------------------------------
*/

function getCache(
  key
) {

  const item =
    cache.get(key);


  if (!item) {

    return null;

  }


  if (
    Date.now() -
    item.createdAt >
    CACHE_TTL
  ) {

    cache.delete(key);

    return null;

  }


  return item.data;

}


/*
|--------------------------------------------------------------------------
| FX BASE CANDLES
|--------------------------------------------------------------------------
*/

app.get(
  "/api/fx/base-candles",
  async (req, res) => {

    console.log(
      "FX DATA REQUEST:",
      req.query
    );


    try {

      /*
       * API KEY
       */

      if (!API_KEY) {

        return res.status(503).json({

          ok: false,

          error:
            "TWELVE_DATA_API_KEY is not configured on Railway."

        });

      }


      /*
       * PAIR
       */

      const pair =
        String(
          req.query.pair || ""
        )
        .trim()
        .toUpperCase();


      if (
        !PAIRS.includes(pair)
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Unsupported FX pair.",

          availablePairs:
            PAIRS

        });

      }


      /*
       * OUTPUT SIZE
       */

      let outputsize =
        parseInt(
          req.query.outputsize ||
          "5000",
          10
        );


      if (
        !Number.isInteger(
          outputsize
        )
      ) {

        outputsize = 5000;

      }


      outputsize =
        Math.max(
          1,
          Math.min(
            MAX_CANDLES,
            outputsize
          )
        );


      /*
       * DATES
       */

      const startDate =
        req.query.startDate
          ? String(
              req.query.startDate
            )
          : "";


      const endDate =
        req.query.endDate
          ? String(
              req.query.endDate
            )
          : "";


      /*
       * CACHE KEY
       */

      const cacheKey = [
        pair,
        startDate,
        endDate,
        outputsize
      ].join("|");


      const cached =
        getCache(cacheKey);


      if (cached) {

        console.log(
          "RETURNING CACHED DATA"
        );


        return res.json({

          ...cached,

          cached: true

        });

      }


      /*
       * PROVIDER URL
       */

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


      if (
        startDate
      ) {

        url.searchParams.set(
          "start_date",
          startDate
        );

      }


      if (
        endDate
      ) {

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
          String(
            outputsize
          )
        );

      }


      console.log(
        "REQUESTING PROVIDER:"
      );

      console.log(
        `PAIR=${pair}`
      );

      console.log(
        `INTERVAL=${BASE_INTERVAL}`
      );


      /*
       * FETCH
       */

      const controller =
        new AbortController();


      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          20000
        );


      let providerResponse;


      try {

        providerResponse =
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

        clearTimeout(
          timeout
        );

      }


      const providerData =
        await providerResponse.json();


      /*
       * PROVIDER ERROR
       */

      if (
        !providerResponse.ok
      ) {

        console.error(
          "PROVIDER HTTP ERROR:",
          providerData
        );


        return res.status(502).json({

          ok: false,

          error:
            "Market data provider HTTP error."

        });

      }


      if (
        providerData.status ===
        "error"
      ) {

        console.error(
          "PROVIDER API ERROR:",
          providerData
        );


        return res.status(502).json({

          ok: false,

          error:
            providerData.message ||
            "Market data provider returned an error."

        });

      }


      /*
       * NORMALIZE
       */

      const candles =
        normalizeCandles(
          providerData.values
        );


      if (
        candles.length === 0
      ) {

        return res.status(404).json({

          ok: false,

          error:
            "Provider returned no valid candles."

        });

      }


      /*
       * RESULT
       */

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


      /*
       * SAVE CACHE
       */

      cache.set(
        cacheKey,
        {

          createdAt:
            Date.now(),

          data:
            result

        }
      );


      console.log(
        `SUCCESS: ${candles.length} candles`
      );


      return res.json(
        result
      );


    } catch (error) {

      console.error(
        "FX DATA ERROR:",
        error
      );


      if (
        error.name ===
        "AbortError"
      ) {

        return res.status(504).json({

          ok: false,

          error:
            "Market data provider timed out."

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
      index: false
    }
  )
);


/*
|--------------------------------------------------------------------------
| UNKNOWN API ROUTES
|--------------------------------------------------------------------------
*/

app.use(
  "/api",
  (req, res) => {

    res.status(404).json({

      ok: false,

      error:
        "API endpoint not found.",

      path:
        req.originalUrl

    });

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
      "================================"
    );

    console.log(
      "TRADING BACKTESTER SERVER"
    );

    console.log(
      `PORT: ${PORT}`
    );

    console.log(
      `AUTOMATIC DATA: ${
        API_KEY
          ? "ENABLED"
          : "DISABLED"
      }`
    );

    console.log(
      `BASE INTERVAL: ${BASE_INTERVAL}`
    );

    console.log(
      "================================"
    );

  }
);
