const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();

const SANMAR_USER = process.env.SANMAR_USERNAME;
const SANMAR_PASS = process.env.SANMAR_PASSWORD;
const SANMAR_ACCT = process.env.SANMAR_ACCOUNT;
const PROXY_API_KEY = process.env.PROXY_API_KEY;
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const PORT = process.env.PORT || 3000;

const required = {
  SANMAR_USERNAME: SANMAR_USER,
  SANMAR_PASSWORD: SANMAR_PASS,
  SANMAR_ACCOUNT: SANMAR_ACCT,
  PROXY_API_KEY,
  CORS_ORIGIN,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const allowedOrigins = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
const corsOptions = allowedOrigins.includes("*") ? { origin: true } : { origin: allowedOrigins };
app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

const requireApiKey = (req, res, next) => {
  if (req.get("X-Proxy-Key") !== PROXY_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
};

const XML_ESCAPES = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => XML_ESCAPES[c]);

const xmlDecode = (s) =>
  String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    return String.fromCodePoint(parseInt(e.slice(1), 10));
  });

const stripCData = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

const extract = (xml, tag) => {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`);
  const m = xml.match(re);
  return m ? xmlDecode(stripCData(m[1])).trim() : "";
};

const extractAll = (xml, tag) => {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>`, "g");
  const out = new Set();
  for (const m of xml.matchAll(re)) {
    const v = xmlDecode(stripCData(m[1])).trim();
    if (v) out.add(v);
  }
  return [...out];
};

const STYLE_RE = /^[A-Za-z0-9\-]+$/;
const SANMAR_URL = "https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort";
const FETCH_TIMEOUT_MS = 15000;
const CONCURRENCY = 4;
const MAX_STYLES = 100;

const buildSoap = (style) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:san="http://www.sanmar.com/"><soapenv:Header/><soapenv:Body><san:getProductInfoByStyleColorSize><arg0><sanMarCustomerNumber>${xmlEscape(SANMAR_ACCT)}</sanMarCustomerNumber><sanMarUserName>${xmlEscape(SANMAR_USER)}</sanMarUserName><sanMarUserPassword>${xmlEscape(SANMAR_PASS)}</sanMarUserPassword></arg0><arg1>${xmlEscape(style)}</arg1><arg2></arg2><arg3></arg3></san:getProductInfoByStyleColorSize></soapenv:Body></soapenv:Envelope>`;

const fetchStyle = async (style, markup) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(SANMAR_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml;charset=UTF-8", SOAPAction: "" },
      body: buildSoap(style),
      signal: ctrl.signal,
    });
    const xml = await r.text();
    if (!r.ok) return { style, error: `upstream ${r.status}` };
    const fault = extract(xml, "faultstring");
    if (fault) return { style, error: fault };
    const title = extract(xml, "productTitle") || extract(xml, "productName");
    if (!title) return { style, error: "no data" };
    const priceStr = extract(xml, "piecePrice") || extract(xml, "ourPrice");
    const cost = parseFloat(priceStr);
    const hasPrice = Number.isFinite(cost) && cost > 0;
    const discontinued = extract(xml, "productStatus").toLowerCase() === "discontinued";
    return {
      title,
      brand: extract(xml, "brandName") || null,
      category: extract(xml, "categoryName") || null,
      base_price: hasPrice ? Math.round(cost * (1 + markup / 100) * 100) / 100 : null,
      colors: extractAll(xml, "catalogColor"),
      sizes: extractAll(xml, "size"),
      image_url: extract(xml, "colorProductImage") || extract(xml, "frontModel") || null,
      description: extract(xml, "productDescription") || null,
      external_id: style,
      external_source: "sanmar",
      is_active: !discontinued,
    };
  } catch (err) {
    return { style, error: err.name === "AbortError" ? "upstream timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
};

const runPool = async (items, worker, concurrency) => {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
};

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "HCP SanMar Proxy" });
});

app.post("/sanmar/bulk", requireApiKey, async (req, res) => {
  const body = req.body || {};
  const styles = Array.isArray(body.styles) ? body.styles : null;
  if (!styles || styles.length === 0) {
    return res.status(400).json({ error: "styles required (non-empty array)" });
  }
  if (styles.length > MAX_STYLES) {
    return res.status(400).json({ error: `too many styles (max ${MAX_STYLES})` });
  }
  for (const s of styles) {
    if (typeof s !== "string" || !STYLE_RE.test(s)) {
      return res.status(400).json({ error: `invalid style: ${JSON.stringify(s)}` });
    }
  }
  const markup = body.markup === undefined ? 40 : Number(body.markup);
  if (!Number.isFinite(markup) || markup < 0 || markup > 10000) {
    return res.status(400).json({ error: "markup must be a number between 0 and 10000" });
  }

  const results = await runPool(styles, (style) => fetchStyle(style, markup), CONCURRENCY);
  res.json({
    imported: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    products: results,
  });
});

app.use((req, res) => res.status(404).json({ error: "not found" }));

app.use((err, req, res, _next) => {
  console.error("unhandled error:", err);
  res.status(500).json({ error: "internal error" });
});

const server = app.listen(PORT, () => console.log(`Proxy listening on port ${PORT}`));
server.on("error", (err) => {
  console.error("server error:", err);
  process.exit(1);
});
