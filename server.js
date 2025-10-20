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
  .map((s) => s.trim());

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

// ---------- Helpers ----------
const parsePriceNumber = (str) => {
  if (!str) return null;
  const cleaned = String(str)
    .replace(/\s/g, "")
    .replace(/[^\d.,-]/g, "")
    .replace(/\.(?=\d{3}\b)/g, "")
    .replace(",", ".");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
};

const extractMeta = ($) => {
  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").first().text()?.trim() ||
    null;
  const image = $('meta[property="og:image"]').attr("content") || null;
  return { title, image };
};

// ---------- Domainspezifische Extraktoren ----------
const extractors = [
  // eBay: stabil über OG/Meta/LD-JSON, danach sichtbarer Text
  {
    test: (url) => /ebay\./i.test(url),
    run: ($) => {
      let byMeta =
        $('meta[property="og:price:amount"]').attr("content") ||
        $('meta[itemprop="price"]').attr("content") ||
        $('meta[name="twitter:data1"]').attr("content");

      let ldPrice = null;
      let ldImage = null;
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).text());
        const arr = Array.isArray(data) ? data : [data];
          for (const o of arr) {
            const p = o?.offers?.price || o?.offers?.lowPrice || o?.price;
            if (!ldPrice && p) ldPrice = p;
            const img =
              (Array.isArray(o.image) ? o.image[0] : o.image) ||
              o?.offers?.image ||
              null;
            if (!ldImage && img) ldImage = img;
          }
        } catch {}
      });

      const byId =
        $("#prcIsum, #mm-saleDscPrc").first().text() ||
        $(".x-price-primary .ux-textspans").first().text() ||
        $("span[itemprop='price']").first().text();

      const image =
        $('meta[property="og:image"]').attr("content") ||
        $("#icImg").attr("src") ||
        $('img[aria-label]').first().attr("src") ||
        ldImage ||
        null;

      const priceStr = byMeta || ldPrice || byId || "";
      const price = parsePriceNumber(priceStr);
      return { price, image };
    },
  },

  // Amazon
  {
    test: (url) => /amazon\./i.test(url),
    run: ($) => {
      const byId = $("#priceblock_ourprice, #priceblock_dealprice, #corePrice_feature_div span.a-offscreen")
        .first()
        .text();
      const byMeta = $('span[data-a-color="price"] .a-offscreen').first().text();
      const price = parsePriceNumber(byId || byMeta);
      return { price, image: null };
    },
  },

  // MediaMarkt / Saturn
  {
    test: (url) => /(mediamarkt|saturn)\./i.test(url),
    run: ($) => {
      const meta = $('meta[itemprop="price"]').attr("content");
      let fromJson = null;
      const jsonld = $('script[type="application/ld+json"]').first().html();
      if (jsonld) {
        try {
          const data = JSON.parse(jsonld);
          fromJson = parsePriceNumber(data?.offers?.price || data?.price);
        } catch {}
      }
      const textSpan = $("span, div")
        .filter((_, el) => $(el).text().match(/€/) && $(el).text().match(/\d/))
        .first()
        .text();
      const price = parsePriceNumber(meta || fromJson || textSpan);
      return { price, image: null };
    },
  },

  // Alternate / Mindfactory / Caseking
  {
    test: (url) => /(alternate|mindfactory|caseking)\./i.test(url),
    run: ($) => {
      const meta = $('meta[itemprop="price"]').attr("content");
      const priceText = $(".price, .price__value, .m-product__price, .article_price, .pprice")
        .first()
        .text();
      const price = parsePriceNumber(meta || priceText);
      return { price, image: null };
    },
  },

  // IKEA
  {
    test: (url) => /ikea\./i.test(url),
    run: ($) => {
      const meta = $('meta[property="product:price:amount"]').attr("content");
      const text = $('[class*="price"]').first().text();
      const price = parsePriceNumber(meta || text);
      return { price, image: null };
    },
  },

  // Fallback (generisch)
  {
    test: () => true,
    run: ($) => {
      const candidates = [
        $('meta[itemprop="price"]').attr("content"),
        $('meta[property="product:price:amount"]').attr("content"),
        $("span.price").first().text(),
        $("div.price").first().text(),
        $("span:contains('€')").first().text(),
        $("div:contains('€')").first().text(),
      ].filter(Boolean);
      for (const c of candidates) {
        const num = parsePriceNumber(c);
        if (num) return { price: num, image: null };
      }
      return { price: null, image: null };
    },
  },
];

// ---------- Preis aus Direktlink ----------
app.get("/api/price", async (req, res) => {
  const targetUrl = req.query.url;
  const fresh = req.query.fresh === "1"; // Force fresh fetch
  try {
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
    }

    const headers = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      "cache-control": fresh ? "no-cache" : "max-age=0",
      pragma: fresh ? "no-cache" : "no-cache",
    };

    let html = null;

    // 1) Direkt
    try {
      html = await got(targetUrl, {
        headers,
        http2: false,
        decompress: true,
        followRedirect: true,
        timeout: { request: 12000 },
        retry: { limit: 0 },
      }).text();
    } catch (err) {
      console.error("Direct fetch failed:", err.response?.statusCode, err.message);
    }

    // 2) Fallback Reader
    if (!html) {
      const readerUrl = "https://r.jina.ai/http://" + targetUrl.replace(/^https?:\/\//, "");
      try {
        html = await got(readerUrl, {
          headers,
          timeout: { request: 12000 },
          retry: { limit: 0 },
        }).text();
      } catch (err) {
        console.error("Reader fallback failed:", err.response?.statusCode, err.message);
      }
    }

    if (!html) {
      return res.status(502).json({ error: "Seite konnte nicht geladen werden", url: targetUrl });
    }

    const $ = cheerio.load(html);
    const meta = extractMeta($);
    const extractor = extractors.find((ex) => ex.test(targetUrl)) || extractors.at(-1);
    let { price, image } = extractor.run($);

    // Falls Domain-Extractor kein Bild liefert, nimm OG
    if (!image) image = meta.image;

    if (!price) {
      // heuristischer Body-Fallback
      const m = $("body").text().match(/(\d{1,3}(\.\d{3})*|\d+),\d{2}\s*€/);
      const num = parsePriceNumber(m?.[0] || "");
      if (num) return res.json({ price: num, title: meta.title, image, via: "fallback" });
      return res.status(404).json({ error: "Kein Preis gefunden", title: meta.title, image });
    }

    return res.json({ price, title: meta.title, image, via: "direct" });
  } catch (err) {
    console.error("Proxy-Fehler /api/price:", err.response?.statusCode, err.message, "URL:", req.query.url);
    return res.status(500).json({ error: "Interner Fehler beim Preisabruf" });
  }
});

// ---------- Bild-Proxy (gegen Hotlink/CORS/Referrer) ----------
app.get("/api/img", async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) return res.status(400).send("Bad image url");
  try {
    const r = await got(target, {
      responseType: "buffer",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        referer: "https://www.google.com/",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      http2: false,
      followRedirect: true,
      decompress: true,
      timeout: { request: 12000 },
      retry: { limit: 0 },
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

// ---------- Root ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK - price-proxy läuft");
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`price-proxy läuft auf Port ${PORT}`);
});
