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

const DEBUG = process.env.DEBUG === "1"; // Setze DEBUG=1 für ausführliche Logs

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
const log = (...args) => {
  if (DEBUG) console.log("[DEBUG]", ...args);
};

const parsePriceNumber = (str) => {
  if (!str) return null;
  
  const cleaned = String(str)
    .replace(/\s+/g, "") // Alle Whitespaces entfernen
    .replace(/[^\d,.\-]/g, ""); // Nur Zahlen, Komma, Punkt, Minus
  
  // Verschiedene Formate unterstützen:
  // 1.299,99 (DE) -> 1299.99
  // 1,299.99 (US) -> 1299.99
  // 1299.99
  // 1299,99
  
  let normalized = cleaned;
  
  // Wenn sowohl Komma als auch Punkt vorhanden:
  if (normalized.includes(",") && normalized.includes(".")) {
    // Bestimme welches das Dezimaltrennzeichen ist (das letzte)
    const lastComma = normalized.lastIndexOf(",");
    const lastDot = normalized.lastIndexOf(".");
    
    if (lastComma > lastDot) {
      // Komma ist Dezimaltrenner (DE-Format: 1.299,99)
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      // Punkt ist Dezimaltrenner (US-Format: 1,299.99)
      normalized = normalized.replace(/,/g, "");
    }
  } else if (normalized.includes(",")) {
    // Nur Komma: Könnte 1299,99 oder 1,299 sein
    const parts = normalized.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      // Wahrscheinlich Dezimaltrenner: 1299,99
      normalized = normalized.replace(",", ".");
    } else {
      // Wahrscheinlich Tausendertrenner: 1,299
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

  // Bild aus Meta-Tags
  const ogImage =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[property="og:image:secure_url"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $('link[rel="image_src"]').attr("href") ||
    null;

  return { title, image: ogImage };
};

const absolutize = (maybeUrl, base) => {
  if (!maybeUrl) return null;
  try {
    // Relative URLs auflösen
    const absolute = new URL(maybeUrl, base).toString();
    // Nur http(s) URLs zurückgeben
    return absolute.startsWith("http") ? absolute : null;
  } catch {
    return null;
  }
};

// ---------- Universal Extractor (Multi-Strategy) ----------
const universalExtract = ($, pageUrl) => {
  let price = null;
  let image = null;
  const strategies = [];

  // STRATEGIE 1: JSON-LD (schema.org Product / Offer)
  $('script[type="application/ld+json"]').each((_, el) => {
    if (price && image) return;
    try {
      const raw = $(el).text();
      if (!raw) return;
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : [data];

      for (const obj of list) {
        if (!obj || typeof obj !== "object") continue;

        // Rekursiv durch @graph gehen
        const items = obj["@graph"] ? obj["@graph"] : [obj];
        
        for (const item of items) {
          if (item["@type"] === "Product" || item["@type"] === "Offer") {
            // Preis aus offers
            const offers = item.offers || item.Offer || [];
            const offerList = Array.isArray(offers) ? offers : [offers];
            
            for (const offer of offerList) {
              if (!price && offer.price) {
                const n = parsePriceNumber(offer.price);
                if (n) {
                  price = n;
                  strategies.push("JSON-LD:offers.price");
                  log("✓ Preis gefunden via JSON-LD offers:", n);
                }
              }
              if (!price && offer.lowPrice) {
                const n = parsePriceNumber(offer.lowPrice);
                if (n) {
                  price = n;
                  strategies.push("JSON-LD:lowPrice");
                }
              }
            }
            
            // Direkter price-Wert
            if (!price && item.price) {
              const n = parsePriceNumber(item.price);
              if (n) {
                price = n;
                strategies.push("JSON-LD:price");
                log("✓ Preis gefunden via JSON-LD direct:", n);
              }
            }

            // Bild
            if (!image) {
              const imgCand = Array.isArray(item.image) 
                ? item.image[0] 
                : item.image;
              if (imgCand) {
                const imgUrl = typeof imgCand === "object" ? imgCand.url : imgCand;
                image = absolutize(imgUrl, pageUrl);
                if (image) {
                  strategies.push("JSON-LD:image");
                  log("✓ Bild gefunden via JSON-LD:", image);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      log("JSON-LD Parse-Fehler:", err.message);
    }
  });

  // STRATEGIE 2: Microdata (itemprop)
  if (!price) {
    const microPrice = $('[itemprop="price"]');
    if (microPrice.length) {
      const val = microPrice.attr("content") || microPrice.text();
      const n = parsePriceNumber(val);
      if (n) {
        price = n;
        strategies.push("microdata:itemprop=price");
        log("✓ Preis gefunden via Microdata:", n);
      }
    }
  }
  
  if (!image) {
    const microImg = $('[itemprop="image"]').first();
    const imgSrc = microImg.attr("src") || microImg.attr("content");
    if (imgSrc) {
      image = absolutize(imgSrc, pageUrl);
      if (image) strategies.push("microdata:itemprop=image");
    }
  }

  // STRATEGIE 3: Open Graph / Twitter Cards
  if (!price) {
    const ogPrice =
      $('meta[property="product:price:amount"]').attr("content") ||
      $('meta[property="og:price:amount"]').attr("content") ||
      $('meta[name="twitter:data1"]').attr("content") ||
      null;
    if (ogPrice) {
      const n = parsePriceNumber(ogPrice);
      if (n) {
        price = n;
        strategies.push("og:price");
        log("✓ Preis gefunden via Open Graph:", n);
      }
    }
  }

  // STRATEGIE 4: Data-Attribute (häufig bei SPAs)
  if (!price) {
    const selectors = [
      '[data-price]',
      '[data-price-amount]', 
      '[data-product-price]',
      '[data-test-id*="price"]',
      '[data-testid*="price"]',
      '[data-cy*="price"]'
    ];
    
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length) {
        const val = el.attr('data-price') || 
                   el.attr('data-price-amount') || 
                   el.attr('data-product-price') ||
                   el.text();
        const n = parsePriceNumber(val);
        if (n) {
          price = n;
          strategies.push(`data-attr:${sel}`);
          log("✓ Preis gefunden via data-attribute:", n);
          break;
        }
      }
    }
  }

  // STRATEGIE 5: Häufige CSS-Klassen/IDs
  if (!price) {
    const priceSelectors = [
      '.price',
      '.product-price',
      '.current-price',
      '.sale-price',
      '.offer-price',
      '#price',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '.a-price .a-offscreen', // Amazon
      '[class*="price"][class*="current"]',
      '[class*="Price"]'
    ];
    
    for (const sel of priceSelectors) {
      const el = $(sel).first();
      if (el.length) {
        const text = el.text();
        const n = parsePriceNumber(text);
        if (n) {
          price = n;
          strategies.push(`css:${sel}`);
          log("✓ Preis gefunden via CSS-Selektor:", sel, n);
          break;
        }
      }
    }
  }

  // STRATEGIE 6: Regex im sichtbaren Text (letzte Rettung)
  if (!price) {
    const bodyText = $("body").text();
    
    // Verschiedene Preis-Patterns
    const patterns = [
      /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*€/g,           // 1.299,99 € oder 1,299.99 €
      /€\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/g,           // € 1.299,99
      /(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*EUR/gi,        // 1299.99 EUR
      /EUR\s*(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/gi,        // EUR 1299.99
      /(\d+[.,]\d{2})\s*€/g,                             // 99.99 € oder 99,99 €
    ];
    
    const foundPrices = [];
    for (const pattern of patterns) {
      const matches = bodyText.matchAll(pattern);
      for (const match of matches) {
        const n = parsePriceNumber(match[1]);
        if (n && n > 0 && n < 1000000) { // Realistischer Bereich
          foundPrices.push(n);
        }
      }
    }
    
    if (foundPrices.length > 0) {
      // Nimm den häufigsten Preis (Mode) oder den kleinsten, wenn alle einzigartig
      const frequency = {};
      foundPrices.forEach(p => frequency[p] = (frequency[p] || 0) + 1);
      const sorted = Object.entries(frequency).sort((a, b) => b[1] - a[1]);
      price = parseFloat(sorted[0][0]);
      strategies.push("regex:body-text");
      log("✓ Preis gefunden via Regex im Body:", price, `(${foundPrices.length} Kandidaten)`);
    }
  }

  // BILD-STRATEGIE: Bessere Produkt-Bild-Erkennung
  if (!image) {
    // Versuche spezifische Produkt-Bild-Container
    const imageSelectors = [
      '.product-image img',
      '.product-gallery img',
      '#main-image',
      '[data-testid="product-image"]',
      '[class*="ProductImage"]',
      '[class*="product-img"]',
      '.gallery-main img',
      '[itemprop="image"]'
    ];
    
    for (const sel of imageSelectors) {
      const img = $(sel).first();
      if (img.length) {
        const src = img.attr("src") || img.attr("data-src") || img.attr("data-lazy");
        if (src) {
          image = absolutize(src, pageUrl);
          if (image && !image.includes("placeholder") && !image.includes("loading")) {
            strategies.push(`img:${sel}`);
            log("✓ Bild gefunden via Selektor:", sel);
            break;
          }
        }
      }
    }
  }
  
  // Fallback: Größtes Bild auf der Seite (> 200x200px)
  if (!image) {
    let bestImg = null;
    let maxSize = 0;
    
    $("img").each((_, el) => {
      const src = $(el).attr("src") || $(el).attr("data-src");
      if (!src) return;
      
      // Überspringe Icons, Logos, etc.
      if (src.includes("icon") || src.includes("logo") || src.includes("sprite")) return;
      
      const width = parseInt($(el).attr("width")) || 0;
      const height = parseInt($(el).attr("height")) || 0;
      const size = width * height;
      
      if (size > maxSize && size > 40000) { // Mindestens ~200x200
        maxSize = size;
        bestImg = src;
      }
    });
    
    if (bestImg) {
      image = absolutize(bestImg, pageUrl);
      if (image) {
        strategies.push("img:largest");
        log("✓ Bild gefunden via largest-image:", image);
      }
    }
  }

  log("Verwendete Strategien:", strategies.join(", "));
  return { price, image, strategies };
};

// ---------- Preis aus Direktlink ----------
app.get("/api/price", async (req, res) => {
  const targetUrl = req.query.url;
  const fresh = req.query.fresh === "1";
  
  try {
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return res.status(400).json({ error: "Parameter 'url' fehlt oder ist ungültig." });
    }

    log("\n=== Neue Anfrage ===");
    log("URL:", targetUrl);

    const headers = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "de-DE,de;q=0.9,en;q=0.8",
      "cache-control": fresh ? "no-cache" : "max-age=0",
      pragma: fresh ? "no-cache" : "no-cache",
    };

    let html = null;

    // Direkter Abruf
    try {
      const response = await got(targetUrl, {
        headers,
        http2: false,
        decompress: true,
        followRedirect: true,
        timeout: { request: 15000 },
        retry: { limit: 1 },
      });
      html = response.body;
      log("✓ Seite erfolgreich geladen (direkt)");
    } catch (err) {
      log("✗ Direkter Abruf fehlgeschlagen:", err.message);
      
      // Fallback: Jina Reader (nur wenn direkt scheitert)
      const readerUrl = "https://r.jina.ai/" + targetUrl;
      try {
        html = await got(readerUrl, {
          headers,
          timeout: { request: 15000 },
          retry: { limit: 0 },
        }).text();
        log("✓ Seite via Jina Reader geladen");
      } catch (err2) {
        log("✗ Jina Reader auch fehlgeschlagen:", err2.message);
      }
    }

    if (!html) {
      return res.status(502).json({ 
        error: "Seite konnte nicht geladen werden", 
        url: targetUrl 
      });
    }

    const $ = cheerio.load(html);
    const meta = extractMeta($);
    const { price, image, strategies } = universalExtract($, targetUrl);

    log("\n=== Ergebnis ===");
    log("Preis:", price);
    log("Titel:", meta.title);
    log("Bild:", image || meta.image);
    log("Strategien:", strategies);

    if (!price) {
      return res.status(404).json({ 
        error: "Kein Preis gefunden", 
        title: meta.title, 
        image: image || meta.image,
        debug: DEBUG ? { strategies } : undefined
      });
    }

    return res.json({
      price,
      title: meta.title,
      image: image || meta.image || null,
      strategies: DEBUG ? strategies : undefined,
    });
    
  } catch (err) {
    console.error("Proxy-Fehler /api/price:", err.message);
    log("Stack:", err.stack);
    return res.status(500).json({ error: "Interner Fehler beim Preisabruf" });
  }
});

// ---------- Bild-Proxy (gegen Hotlink/CORS/Referrer) ----------
app.get("/api/img", async (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("Bad image url");
  }
  
  try {
    const r = await got(target, {
      responseType: "buffer",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8",
        referer: new URL(target).origin + "/",
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

// ---------- Root ----------
app.get("/", (_req, res) => {
  res.type("text/plain").send("OK - Universal Price Proxy v2.0");
});

// ---------- Health Check ----------
app.get("/health", (_req, res) => {
  res.json({ 
    status: "ok", 
    version: "2.0",
    debug: DEBUG 
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Universal Price Proxy läuft auf Port ${PORT}`);
  console.log(`📊 Debug-Modus: ${DEBUG ? "AN" : "AUS"}`);
  console.log(`🌐 CORS Origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
