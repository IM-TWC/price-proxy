import express from "express";
import cors from "cors";
import got from "got";
import * as cheerio from "cheerio";
import { URL } from "url";

const app = express();

/* =========================
   Konfiguration
   ========================= */
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());
const DEBUG = process.env.DEBUG === "1";
const USE_BROWSER = process.env.USE_BROWSER === "1"; // Headless Browser erlauben?

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("Not allowed by CORS"));
    },
  })
);

/* =========================
   Helpers
   ========================= */
const log = (...args) => {
  if (DEBUG) console.log("[DEBUG]", ...args);
};

const parsePriceNumber = (str) => {
  if (!str && str !== 0) return null;
  const cleaned = String(str).replace(/\s+/g, "").replace(/[^\d,.\-]/g, "");
  let normalized = cleaned;
  if (normalized.includes(",") && normalized.includes(".")) {
    const lastComma = normalized.lastIndexOf(",");
    const lastDot = normalized.lastIndexOf(".");
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (normalized.includes(",")) {
    const parts = normalized.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      normalized = normalized.replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  }
  const num = parseFloat(normalized);
  return Number.isFinite(num) && num > 0 ? num : null;
};

const extractMeta = ($) => {
  const title =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("title").first().text()?.trim() ||
    $("h1").first().text()?.trim() ||
    null;

  const image =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[property="og:image:secure_url"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $('link[rel="image_src"]').attr("href") ||
    null;

  return { title, image };
};

const absolutize = (maybeUrl, base) => {
  if (!maybeUrl) return null;
  try {
    const absolute = new URL(maybeUrl, base).toString();
    return absolute.startsWith("http") ? absolute : null;
  } catch {
    return null;
  }
};

// JSON-Blobs aus <script>-Tags (SPA) scannen
const collectFromJSON = (obj, acc) => {
  if (!obj || typeof obj !== "object") return;

  const priceKeys = [
    "price", "currentPrice", "salesPrice", "salePrice",
    "finalPrice", "priceValue", "unitPrice", "lowPrice",
    "offerPrice", "amount", "value"
  ];
  const imageKeys = [
    "image", "imageUrl", "imageURL", "img", "thumbnail",
    "thumbnailUrl", "primaryImage", "mediaUrl", "src", "url"
  ];

  if (Array.isArray(obj)) {
    for (const el of obj) collectFromJSON(el, acc);
    return;
  }

  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();

    if (priceKeys.some((pk) => lk.includes(pk.toLowerCase()))) {
      const n = parsePriceNumber(v);
      if (n) acc.prices.push(n);
    }

    if (imageKeys.some((ik) => lk.includes(ik.toLowerCase()))) {
      if (typeof v === "string") acc.images.push(v);
      else if (v && typeof v === "object") {
        if (v.url) acc.images.push(v.url);
        if (v.src) acc.images.push(v.src);
      }
    }

    if (v && typeof v === "object") collectFromJSON(v, acc);
  }
};

const extractFromInlineJSON = ($, pageUrl) => {
  const acc = { prices: [], images: [] };

  $('script:not([type]),script[type="application/json"],script[type*="ld+json"]').each((_, el) => {
    const txt = $(el).text();
    if (!txt || txt.length < 40) return;

    let parsed = null;
    try {
      parsed = JSON.parse(txt);
    } catch {
      // Versuche Preisstrings direkt zu fischen
      const priceRegexes = [
        /"price"\s*:\s*"([^"]+)"/gi,
        /"currentPrice"\s*:\s*"([^"]+)"/gi,
        /"salesPrice"\s*:\s*"([^"]+)"/gi,
        /"finalPrice"\s*:\s*"([^"]+)"/gi,
        /"lowPrice"\s*:\s*"([^"]+)"/gi,
        /"amount"\s*:\s*"([^"]+)"/gi,
        /"value"\s*:\s*"([^"]+)"/gi,
      ];
      for (const re of priceRegexes) {
        let m;
        while ((m = re.exec(txt))) {
          const n = parsePriceNumber(m[1]);
          if (n) acc.prices.push(n);
        }
      }
      const imgMatches = txt.match(/https?:\/\/[^\s"'\\)]+?\.(?:jpg|jpeg|png|webp)/gi);
      if (imgMatches) acc.images.push(...imgMatches);
      return;
    }

    try {
      collectFromJSON(parsed, acc);
    } catch {}
  });

  const imagesAbs = acc.images
    .map((u) => absolutize(u, pageUrl))
    .filter(Boolean)
    .filter((u) => !/sprite|icon|logo|placeholder|loading/i.test(u));

  let price = null;
  if (acc.prices.length) {
    const freq = {};
    acc.prices.forEach((p) => (freq[p] = (freq[p] || 0) + 1));
    const sorted = Object.entries(freq).sort((a, b) =>
      b[1] === a[1] ? Number(a[0]) - Number(b[0]) : b[1] - a[1]
    );
    price = parseFloat(sorted[0][0]);
  }

  const image = imagesAbs[0] || null;
  return { price, image };
};

/* =========================
   Universal Extractor (statisch)
   ========================= */
const universalExtract = ($, pageUrl) => {
  let price = null;
  let image = null;
  const strategies = [];

  // JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    if (price && image) return;
    try {
      const raw = $(el).text();
      if (!raw) return;
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : [data];

      for (const obj of list) {
        if (!obj || typeof obj !== "object") continue;
        const nodes = obj["@graph"] ? obj["@graph"] : [obj];

        for (const node of nodes) {
          if (node["@type"] === "Product" || node["@type"] === "Offer") {
            const offers = node.offers || node.Offer || [];
            const offerList = Array.isArray(offers) ? offers : [offers];

            for (const offer of offerList) {
              if (!price && offer?.price) {
                const n = parsePriceNumber(offer.price);
                if (n) { price = n; strategies.push("JSON-LD:offers.price"); }
              }
              if (!price && offer?.lowPrice) {
                const n = parsePriceNumber(offer.lowPrice);
                if (n) { price = n; strategies.push("JSON-LD:offers.lowPrice"); }
              }
            }
            if (!price && node?.price) {
              const n = parsePriceNumber(node.price);
              if (n) { price = n; strategies.push("JSON-LD:price"); }
            }

            if (!image) {
              const imgCand = Array.isArray(node.image) ? node.image[0] : node.image;
              const imgUrl = typeof imgCand === "object" ? imgCand?.url : imgCand;
              const abs = absolutize(imgUrl, pageUrl);
              if (abs) { image = abs; strategies.push("JSON-LD:image"); }
            }
          }
        }
      }
    } catch (err) {
      log("JSON-LD parse error:", err.message);
    }
  });

  // Microdata
  if (!price) {
    const el = $('[itemprop="price"]').first();
    const val = el.attr("content") || el.text();
    const n = parsePriceNumber(val);
    if (n) { price = n; strategies.push("microdata:price"); }
  }
  if (!image) {
    const img = $('[itemprop="image"]').first();
    const src = img.attr("src") || img.attr("content");
    const abs = absolutize(src, pageUrl);
    if (abs) { image = abs; strategies.push("microdata:image"); }
  }

  // OG/Twitter
  if (!price) {
    const og =
      $('meta[property="product:price:amount"]').attr("content") ||
      $('meta[property="og:price:amount"]').attr("content") ||
      $('meta[name="twitter:data1"]').attr("content") ||
      null;
    const n = parsePriceNumber(og);
    if (n) { price = n; strategies.push("og/twitter:price"); }
  }
  if (!image) {
    const metaImg =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content");
    const abs = absolutize(metaImg, pageUrl);
    if (abs) { image = abs; strategies.push("og/twitter:image"); }
  }

  // data-*
  if (!price) {
    const selectors = [
      "[data-price]",
      "[data-price-amount]",
      "[data-product-price]",
      "[data-test-id*='price']",
      "[data-testid*='price']",
      "[data-cy*='price']",
    ];
    for (const sel of selectors) {
      const el = $(sel).first();
      if (!el.length) continue;
      const val =
        el.attr("data-price") ||
        el.attr("data-price-amount") ||
        el.attr("data-product-price") ||
        el.text();
      const n = parsePriceNumber(val);
      if (n) { price = n; strategies.push(`data-attr:${sel}`); break; }
    }
  }

  // CSS (priorisiert „current/sale/final“)
  if (!price) {
    const currentFirst = [
      ".price--current", ".price__current", ".price-current",
      ".current-price", ".sales-price", ".final-price",
      ".priceToPay .a-offscreen", ".a-price .a-offscreen",
    ];
    const genericLater = [
      ".sale-price", ".offer-price", ".product-price", ".price",
      "#price", "#priceblock_ourprice", "#priceblock_dealprice",
      ".a-price-whole", "span.a-price > span.a-offscreen",
      "[data-a-color='price']",
      "[class*='price'][class*='current']",
      "[class*='Price']",
    ];
    const trySelectors = (sels) => {
      for (const sel of sels) {
        const el = $(sel).first();
        if (!el.length) continue;
        const txt = el.text();
        if (/\b(uvp|statt|vorher|durchgestrichen|unverbindlich)\b/i.test(txt)) continue;
        const n = parsePriceNumber(txt);
        if (n) return { n, sel };
      }
      return null;
    };
    let found = trySelectors(currentFirst);
    if (!found) found = trySelectors(genericLater);
    if (found?.n) {
      price = found.n;
      strategies.push(`css:${found.sel}`);
    }
  }

  // JSON-Blob-Extractor (SPAs)
  if (!price || !image) {
    const fromJSON = extractFromInlineJSON($, pageUrl);
    if (!price && fromJSON.price) {
      price = fromJSON.price;
      strategies.push("jsonblob:price");
    }
    if (!image && fromJSON.image) {
      image = fromJSON.image;
      strategies.push("jsonblob:image");
    }
  }

  // Regex-Fallback
  if (!price) {
    const body = $("body").text();
    const patterns = [
      /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*€/g,
      /€\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/g,
      /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*EUR/gi,
      /EUR\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/gi,
    ];
    const all = [];
    for (const re of patterns) {
      for (const m of body.matchAll(re)) {
        const n = parsePriceNumber(m[1]);
        if (!n || n <= 0 || n > 1_000_000) continue;
        all.push(n);
      }
    }
    if (all.length) {
      const freq = {};
      for (const p of all) freq[p] = (freq[p] || 0) + 1;
      const sorted = Object.entries(freq).sort((a, b) =>
        b[1] === a[1] ? Number(a[0]) - Number(b[0]) : b[1] - a[1]
      );
      price = parseFloat(sorted[0][0]);
      strategies.push("regex:body");
    }
  }

  // Bild-Fallbacks
  if (!image) {
    const imageSelectors = [
      "#landingImage", "#imgBlkFront",
      ".product-image img", ".product-gallery img",
      "#main-image", "[data-testid='product-image']",
      "[class*='ProductImage']", "[class*='product-img']",
      ".gallery-main img", "[itemprop='image']",
      "img[data-old-hires]",
    ];
    for (const sel of imageSelectors) {
      const img = $(sel).first();
      const src = img.attr("src") || img.attr("data-src") || img.attr("data-lazy");
      const abs = absolutize(src, pageUrl);
      if (abs && !abs.includes("placeholder") && !abs.includes("loading")) {
        image = abs;
        strategies.push(`img:${sel}`);
        break;
      }
    }
  }
  if (!image) {
    let best = null, maxArea = 0;
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (!src) return;
      if (src.includes("icon") || src.includes("logo") || src.includes("sprite")) return;
      const w = parseInt($(el).attr("width")) || 0;
      const h = parseInt($(el).attr("height")) || 0;
      const area = w * h;
      if (area > maxArea && area > 40000) { maxArea = area; best = src; }
    });
    const abs = absolutize(best, pageUrl);
    if (abs) { image = abs; strategies.push("img:largest"); }
  }

  // Reconciliation: nimm plausibel sichtbaren Minimalpreis
  try {
    const text = $("body").text();
    const euroMatches = Array.from(
      text.matchAll(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*€/g)
    ).map((m) => parsePriceNumber(m[1])).filter(Boolean);
    if (euroMatches.length) {
      const minVisible = Math.min(...euroMatches);
      if (price && minVisible < price && minVisible >= price * 0.5) {
        price = minVisible;
        strategies.push("reconcile:minVisible");
      }
    }
  } catch {}

  return { price, image, strategies };
};

/* =========================
   Headless Render (Playwright)
   ========================= */
let browserSingleton = null;
async function getBrowser() {
  if (!browserSingleton) {
    const { chromium } = await import("playwright"); // dynamic import
    browserSingleton = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserSingleton;
}

async function renderWithBrowser(targetUrl, timeoutMs = 15000) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    bypassCSP: true,
    javaScriptEnabled: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Cookie-Banner heuristisch „akzeptieren“
    const acceptTexts = ["zustimmen", "akzeptieren", "alle akzeptieren", "accept all", "accept"];
    for (const text of acceptTexts) {
      const el = await page.$(`text=${text}`);
      if (el) {
        try { await el.click({ timeout: 1000 }); } catch {}
      }
    }

    // warte kurz auf Preise/Bilder
    await page.waitForTimeout(1200);

    // Versuch: JSON-LD & DOM nachladen
    const html = await page.content();
    return html;
  } finally {
    await context.close();
  }
}

/* =========================
   /api/price
   ========================= */
app.get("/api/price", async (req, res) => {
  let targetUrl = (req.query.url || "").trim();
  const freshQuery = req.query.fresh === "1";
  const forceRender = req.query.render === "1"; // manuell rendern

  try {
    if (!targetUrl) {
      return res.status(400).json({ error: "Parameter 'url' fehlt." });
    }
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = "https://" + targetUrl;
      log("URL korrigiert:", targetUrl);
    }
    try { new URL(targetUrl); } catch { return res.status(400).json({ error: "Ungültige URL." }); }

    // Preisvergleich-UTMs → fresh
    let forceFresh = freshQuery;
    try {
      const u = new URL(targetUrl);
      if (/(idealo|geizhals|billiger)/i.test(u.search)) forceFresh = true;
    } catch {}

    log("\n=== Anfrage ===");
    log("URL:", targetUrl);

    const headers = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "accept-language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      "accept-encoding": "gzip, deflate, br",
      "cache-control": forceFresh ? "no-cache" : "max-age=0",
      pragma: forceFresh ? "no-cache" : "no-cache",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "upgrade-insecure-requests": "1",
    };

    let html = null;
    let used = "direct";

    // 1) Direkt laden
    try {
      const resp = await got(targetUrl, {
        headers,
        http2: false,
        decompress: true,
        followRedirect: true,
        timeout: { request: 15000 },
        retry: { limit: 1 },
      });
      html = resp.body;
      log("✓ Direkt geladen. Status:", resp.statusCode, "Len:", resp.body?.length);
    } catch (err) {
      log("✗ Direkt fehlgeschlagen:", err.message, err.response?.statusCode);
      if (targetUrl.includes("amazon.")) {
        try {
          const resp2 = await got(targetUrl, {
            headers: { ...headers, referer: "https://www.google.com/", cookie: "session-id=000-0000000-0000000" },
            http2: false,
            decompress: true,
            followRedirect: true,
            timeout: { request: 15000 },
            retry: { limit: 0 },
          });
          html = resp2.body;
          log("✓ Amazon-Retry erfolgreich");
        } catch {
          log("✗ Amazon-Retry fehlgeschlagen");
        }
      }
    }

    // 2) Reader-Fallback
    if (!html) {
      used = "reader";
      const readerUrl = "https://r.jina.ai/http://" + targetUrl.replace(/^https?:\/\//, "");
      try {
        html = await got(readerUrl, {
          headers,
          timeout: { request: 15000 },
          retry: { limit: 0 },
        }).text();
        log("✓ Via Reader geladen");
      } catch (err2) {
        log("✗ Reader fehlgeschlagen:", err2.message);
      }
    }

    // 3) Headless Render (falls erlaubt & nötig)
    let viaBrowser = false;
    if ((forceRender || USE_BROWSER) && (!html || used === "reader")) {
      viaBrowser = true;
      try {
        html = await renderWithBrowser(targetUrl, 20000);
        used = "browser";
        log("✓ Headless-Render erfolgreich");
      } catch (err3) {
        log("✗ Headless-Render fehlgeschlagen:", err3.message);
      }
    }

    if (!html) {
      return res.status(502).json({ error: "Seite konnte nicht geladen werden", url: targetUrl });
    }

    const $ = cheerio.load(html);
    const meta = extractMeta($);
    const { price, image, strategies } = universalExtract($, targetUrl);

    log("=== Ergebnis ===");
    log("Quelle:", used, viaBrowser ? "(rendered)" : "");
    log("Preis:", price);
    log("Titel:", meta.title);
    log("Bild:", image || meta.image);
    log("Strategien:", strategies);

    if (!price) {
      // Wenn Browser erlaubt & noch nicht verwendet → letzter Versuch
      if (USE_BROWSER && !viaBrowser) {
        try {
          const html2 = await renderWithBrowser(targetUrl, 20000);
          const $2 = cheerio.load(html2);
          const meta2 = extractMeta($2);
          const out2 = universalExtract($2, targetUrl);
          if (out2.price) {
            return res.json({
              price: out2.price,
              title: meta2.title,
              image: out2.image || meta2.image || null,
              strategies: DEBUG ? out2.strategies.concat(["final:browser"]) : undefined,
            });
          }
        } catch {}
      }

      return res.status(404).json({
        error: "Kein Preis gefunden",
        title: meta.title,
        image: image || meta.image || null,
        debug: DEBUG ? { strategies, source: used } : undefined,
      });
    }

    return res.json({
      price,
      title: meta.title,
      image: image || meta.image || null,
      strategies: DEBUG ? strategies.concat([`source:${used}`]) : undefined,
    });
  } catch (err) {
    console.error("Proxy-Fehler /api/price:", err.message);
    log("Stack:", err.stack);
    return res.status(500).json({ error: "Interner Fehler beim Preisabruf" });
  }
});

/* =========================
   /api/img  (Bild-Proxy mit Amazon-Referer-Härte)
   ========================= */
app.get("/api/img", async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("Bad image url");
  }
  try {
    const u = new URL(target);
    let referer = u.origin + "/";
    const host = u.hostname;
    if (
      /(^|\.)images-amazon\.com$/i.test(host) ||
      /(^|\.)ssl-images-amazon\.com$/i.test(host) ||
      /(^|\.)media-amazon\.com$/i.test(host) ||
      /(^|\.)m\.media-amazon\.com$/i.test(host)
    ) {
      const guess = host.endsWith(".co.uk") ? "https://www.amazon.co.uk/"
        : host.endsWith(".com") ? "https://www.amazon.com/"
        : "https://www.amazon.de/";
      referer = guess;
    }

    const r = await got(target, {
      responseType: "buffer",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        referer,
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      http2: false,
      followRedirect: true,
      decompress: true,
      timeout: { request: 12000 },
      retry: { limit: 1 },
    });
    res.setHeader("Content-Type", r.headers["content-type"] || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(r.body);
  } catch (e) {
    console.error("IMG proxy failed:", e.message);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(502).send("");
  }
});

/* =========================
   Root & Health
   ========================= */
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK - Universal Price Proxy v3 (static+browser)");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "3.0", debug: DEBUG, browser: USE_BROWSER });
});

/* =========================
   Start
   ========================= */
app.listen(PORT, () => {
  console.log(`🚀 Universal Price Proxy läuft auf Port ${PORT}`);
  console.log(`📊 Debug-Modus: ${DEBUG ? "AN" : "AUS"}`);
  console.log(`🧭 Headless Browser: ${USE_BROWSER ? "AN" : "AUS"}`);
  console.log(`🌐 CORS Origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
