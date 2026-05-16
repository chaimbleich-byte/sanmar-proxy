# sanmar-proxy

Express proxy that wraps SanMar's SOAP product API and returns normalized JSON.

## Required environment variables

| Var | Purpose |
| --- | --- |
| `SANMAR_USERNAME` | SanMar web service username |
| `SANMAR_PASSWORD` | SanMar web service password |
| `SANMAR_ACCOUNT` | SanMar customer number |
| `PROXY_API_KEY` | Shared secret; callers must send it as `X-Proxy-Key` |
| `CORS_ORIGIN` | Comma-separated list of allowed origins (use `*` to allow any) |
| `PORT` | Optional, defaults to `3000` |

The process refuses to start if any required var is missing.

## Endpoints

### `GET /`
Health check.

### `POST /sanmar/bulk`
Headers: `X-Proxy-Key: <PROXY_API_KEY>`, `Content-Type: application/json`.

Body:
```json
{ "styles": ["PC61", "DT6000"], "markup": 40 }
```

- `styles`: 1–100 alphanumeric style codes (`[A-Za-z0-9-]+`).
- `markup`: optional, number 0–10000 (percent), defaults to `40`.

Response:
```json
{
  "imported": 2,
  "failed": 0,
  "products": [ { "title": "...", "base_price": 13.98, "...": "..." } ]
}
```

Failed rows appear in `products` as `{ "style": "...", "error": "..." }`.
