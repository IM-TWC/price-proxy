import express from "express";
import cors from "cors";
import got from "got";
import * as cheerio from "cheerio";
import qs from "qs";

const app = express();

// --- Konfiguration ---
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error("Not allowed by CORS"));
  }
}));

// Helper
const parsePriceNumber = (str) => {
  if (!str) return null;
  const cleaned = String(str)
    .replace(/\s/g, "")
    .replace(/[^\d.,-]/g, "")
    .replace(/\.(?=\d{3}\b)/g, "")
    .replace(",", ".");
  const num = parseFloat(cleaned);
  return isFinite(num) ? num : null;
};

const extractMeta = ($) => {
  const title = $('meta[property="og:title"]').attr("content")
    || $("title").first().text()?.trim()
    || null;
  const image = $('meta[property="og:image"]').attr("content") || null;
  return { title, image };
};

// Domainspezifische Extraktoren (vereinfachte Heuristik)
const extractors = [
  {
    test: (url) => /amazon\./i.test(url),
    run: ($) => {
      const byId = $("#priceblock_ourprice, #priceblock_dealprice, #corePrice_feature_div span.a-offscreen").first().text();
      const byMeta = $('span[data-a-color="price"] .a-offscreen').first().text();
      return parsePriceNumber(byId || byMeta);
    }
  },
  {
    test: (url) => /(mediamarkt|saturn)\./i.test(url),
    run: ($) => {
      const meta = $('meta[itemprop="price"]').attr("content");
      const jsonld = $('script[type="application/ld+json"]').first().html();
      let fromJson = null;
      if (jsonld) {
        try {
          const data = JSON.parse(jsonld);
          fromJson = parsePriceNumber(data?.offers?.price || data?.price);
        } catch {}
      }
      const textSpan = $("span, div").filter((_, el) => $(el).text().match(/€/) && $(el).text().match(/\d/)).first().text();
      return parsePriceNumber(meta || fromJson || textSpan);
    }
  },
  {
    test: (url) => /(alternate|mindfactory|caseking)\./i.test(url),
    run: ($) => {
      const meta = $('meta[itemprop="price"]').attr("content");
      const priceText = $(".price, .price__value, .m-product__price, .article_price, .pprice").first().text();
      return parsePriceNumber(meta || priceText);
    }
  },
  {
    test: (url) => /ikea\./i.test(url),
    run: ($) => {
      const meta = $('meta[property="product:price:amount"]').attr("content");
      const text = $('[class*="price"]').first().text();
      return parsePriceNumber(meta || text);
    }
  },
  {
    test: () => true,
    run: ($) => {
      const candidates = [
        $('meta[itemprop="price"]').attr("content"),
        $('meta[property="product:price:amount"]').attr("content"),
        $("span.price").first().text(),
        $("div.price").first().text(),
        $("span:contains('€')").first().text(),
        $("div:contains('€')").first().text()
      ].filter(Boolean);
      for (const c of candidates) {
        const num = parsePriceNumber(c);
        if (num) return num;
      }
      return null;
    }
  }
];

// --- Preis aus Direktlink ---
app.get("/api/price", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
    }
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    const html = await got(url, {
      headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml" },
      timeout: { request: 10000 }
    }).text();

    const $ = cheerio.load(html);
    const { title, image } = extractMeta($);
    const extractor = extractors.find(ex => ex.test(url)) || extractors.at(-1);
    const price = extractor.run($);

    if (!price) return res.status(404).json({ error: "Kein Preis gefunden", title, image });
    return res.json({ price, title, image });
  } catch (err) {
    console.error("Proxy-Fehler:", err.message);
    return res.status(500).json({ error: "Interner Fehler beim Preisabruf" });
  }
});

// --- Bestpreis über Shopping-Suche (SerpAPI) ---
app.get("/api/best-price", async (req, res) => {
  try {
    const { query, fallbackUrl } = req.query;
    let q = (query || "").trim();

    if (!q && fallbackUrl) {
      try {
        const html = await got(fallbackUrl).text();
        const $ = cheerio.load(html);
        q = $('meta[property="og:title"]').attr("content") || $("title").first().text().trim();
      } catch {}
    }

    if (!q) return res.status(400).json({ error: "Query oder fallbackUrl erforderlich" });

    const SERPAPI_KEY = process.env.SERPAPI_KEY;
    if (!SERPAPI_KEY) return res.status(501).json({ error: "SERPAPI_KEY fehlt" });

    const params = {
      engine: "google_shopping",
      q,
      hl: "de",
      gl: "de",
      api_key: SERPAPI_KEY
    };
    const url = "https://serpapi.com/search.json?" + qs.stringify(params);
    const resp = await got(url, { timeout: { request: 10000 } }).json();
    const items = (resp && resp.shopping_results) || [];

    const pickBest = (items=[]) => {
      let best = null;
      for (const it of items) {
        const priceRaw = it.price || it.extracted_price || it.price_raw || "";
        const price = typeof priceRaw === "number" ? priceRaw : parsePriceNumber(priceRaw);
        if (!price) continue;
        if (!best || price < best.price) {
          best = {
            title: it.title || it.name || "Produkt",
            price,
            merchant: it.source || it.merchant || it.store || null,
            url: it.link || it.product_link || it.url || null,
            image: it.thumbnail || it.image || null,
          };
        }
      }
      return best;
    };

    const best = pickBest(items);
    if (!best) return res.status(404).json({ error: "Kein Preis gefunden" });
    return res.json(best);
  } catch (err) {
    console.error("best-price error:", err.message);
    return res.status(500).json({ error: "Interner Fehler bei best-price" });
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("OK - price-proxy läuft");
});

app.listen(PORT, () => {
  console.log(`price-proxy läuft auf Port ${PORT}`);
});
