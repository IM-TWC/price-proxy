import express from "express";
import cors from "cors";
import got from "got";
import * as cheerio from "cheerio";
import { URL } from "url";

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
    // Punkte als Tausendertrenner entfernen (1.299,00 -> 1299,00)
    .replace(/\.(?=\d{3}\b)/g, "")
    // nur Ziffern, Komma, Punkt und Minus behalten
    .replace(/[^\d,.\-]/g, "")
    // deutsches Komma in Punkt
    .replace(",", ".");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
};

const extractMeta = ($) => {
  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").first().text()?.trim() ||
    null;

  // twitter:image, og:image, image_src, itemprop=image
  const ogImage =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $('link[rel="image_src"]').attr("href") ||
    $('img[itemprop="image"]').attr("src") ||
    null;

  return { title, image: ogImage };
};

const absolutize = (maybeUrl, base) => {
  if (!maybeUrl) return null;
  try {
    return new URL(maybeUrl, base).toString();
  } catch {
    return null;
  }
};

// ---------- Universal Extractor (schema.org + meta + heuristics) ----------
const universalExtract = ($, pageUrl) => {
  let price = null;
  let image = null;

  // 1) JSON-LD (schema.org Product / Offer)
  $('script[type="application/ld+json"]').each((_, el) => {
    if (price && image) return;
    try {
      const raw = $(el).text();
      if (!raw) return;
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : [data];

      for (const obj of list) {
        if (!obj || typeof obj !== "object") continue;

        // Product mit offers
        const offers = obj.offers || obj.aggregateOffer || obj.aggregateOffers || obj.Offer || null;
        const priceCandidate =
          (offers && (offers.price || offers.lowPrice || offers.highPrice)) ||
          obj.price ||
          null;

        if (!price && priceCandidate) {
          const n = parsePriceNumber(priceCandidate);
          if (n) price = n;
        }

        const imageCand =
          (Array.isArray(obj.image) ? obj.image[0] : obj.image) ||
          (offers && offers.image) ||
          null;

        if (!image && imageCand) {
          image = absolutize(imageCand, pageUrl);
        }

        if (price && image) break;
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  });

  // 2) Microdata / itemprop
  if (!price) {
    const micro = $('*[itemprop="price"]').first();
    const val = micro.attr("content") || micro.text();
    const n = parsePriceNumber(val);
    if (n) price = n;
  }
  if (!image) {
    const microImg = $('*[itemprop="image"]').first().attr("src");
    if (microImg) image = absolutize(microImg, pageUrl);
  }

  // 3) Open Graph / Twitter
  if (!price) {
    const ogPrice =
      $('meta[property="product:price:amount"]').attr("content") ||
      $('meta[property="og:price:amount"]').attr("content") ||
      $('meta[name="twitter:data1"]').attr("content") ||
      null;
    const n = parsePriceNumber(ogPrice);
    if (n) price = n;
  }
  if (!image) {
    const metaImg =
      $('meta[property="og:image"]').attr("content") ||
      $('meta[name="twitter:image"]').attr("content");
    if (metaImg) image = absolutize(metaImg, pageUrl);
  }

  // 4) Daten-Attribute / häufige Klassen
  if (!price) {
    const dataAttr =
      $('[data-price]').attr('data-price') ||
      $('[data-price-amount]').attr('data-price-amount') ||
      $('[data-product-price]').attr('data-product-price') ||
      null;
    const n = parsePriceNumber(dataAttr);
    if (n) price = n;
  }

  // 5) Heuristik im sichtbaren Text: €-Preise
  if (!price) {
    // Nimm den ersten realistischen Euro-Preis im Body
    const bodyText = $("body").text();
    const matches = bodyText.match(/(\d{1,3}(\.\d{3})*|\d+),\d{2}\s*€+/g);
    if (matches && matches.length) {
      // wähle den kleinsten sinnvollen Wert (> 0)
      let best = null;
      for (const m of matches) {
        const n = parsePriceNumber(m);
        if (!n || n <= 0) continue;
        if (best == null || n < best) best = n;
      }
      if (best) price = best;
    }
  }

  // 6) Bild als Fallback: erstes großes Produktbild in der Seite
  if (!image) {
    const candImg =
      $('img[alt*="produkt"], img[alt*="Product"], img[alt*="Artikel"]').first().attr("src") ||
      $("img").filter((_, el) => {
        const w = Number($(el).attr("width"));
        const h = Number($(el).attr("height"));
        return (w >= 120 && h >= 90) || (!isNaN(w) && w >= 120) || (!isNaN(h) && h >= 90);
      }).first().attr("src") ||
      null;
    if (candImg) image = absolutize(candImg, pageUrl);
  }

  return { price, image };
};

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

    // 1) Direkt abrufen
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

    // 2) Fallback Reader (liefert gerenderten Text)
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
    const { price, image } = universalExtract($, targetUrl);

    if (!price) {
      return res.status(404).json({ error: "Kein Preis gefunden", title: meta.title, image: image || meta.image });
    }

    return res.json({
      price,
      title: meta.title,
      image: image || meta.image || null,
      via: "universal",
    });
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
