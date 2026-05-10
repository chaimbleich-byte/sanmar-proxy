const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const SANMAR_USER = process.env.SANMAR_USERNAME;
const SANMAR_PASS = process.env.SANMAR_PASSWORD;
const SANMAR_ACCT = process.env.SANMAR_ACCOUNT;
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "HCP SanMar Proxy" });
});

app.post("/sanmar/bulk", async (req, res) => {
  const { styles = [], markup = 40 } = req.body;
  if (!styles.length) return res.status(400).json({ error: "styles required" });
  const results = [];
  for (const style of styles.slice(0, 100)) {
    const soap = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:san="http://www.sanmar.com/"><soapenv:Header/><soapenv:Body><san:getProductInfoByStyleColorSize><arg0><sanMarCustomerNumber>${SANMAR_ACCT}</sanMarCustomerNumber><sanMarUserName>${SANMAR_USER}</sanMarUserName><sanMarUserPassword>${SANMAR_PASS}</sanMarUserPassword></arg0><arg1>${style}</arg1><arg2></arg2><arg3></arg3></san:getProductInfoByStyleColorSize></soapenv:Body></soapenv:Envelope>`;
    try {
      const r = await fetch("https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort", {
        method: "POST", headers: { "Content-Type": "text/xml;charset=UTF-8", "SOAPAction": "" }, body: soap
      });
      const xml = await r.text();
      const get = (tag) => xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`))?.[1]?.trim() || "";
      const getAll = (tag) => [...new Set([...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, "g"))].map(m => m[1].trim()).filter(Boolean))];
      const title = get("productTitle") || get("productName");
      if (!title) { results.push({ style, error: "no data" }); continue; }
      const cost = parseFloat(get("piecePrice") || get("ourPrice") || "0");
      results.push({
        title, brand: get("brandName") || "SanMar",
        category: get("categoryName") || "T-Shirts",
        base_price: cost > 0 ? Math.round(cost * (1 + markup / 100) * 100) / 100 : 9.99,
        colors: getAll("catalogColor"), sizes: getAll("size"),
        image_url: get("colorProductImage") || get("frontModel") || "",
        description: get("productDescription") || "",
        external_id: style, external_source: "sanmar", is_active: true,
      });
    } catch (err) { results.push({ style, error: err.message }); }
    await new Promise(r => setTimeout(r, 200));
  }
  res.json({ imported: results.filter(r => !r.error).length, products: results });
});

app.listen(PORT, () => console.log("Proxy running on port " + PORT));
