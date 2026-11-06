# URL shortener

A URL shortener on Cloudflare Workers with a local D1 database.

## Run locally

```sh
yarn install
npm run dev          # applies migrations to the local D1, then starts wrangler dev on :8787
npm run dev -- --port 8788   # if 8787 is taken
```

Open http://localhost:8787. Data lives in `.wrangler/state` and survives restarts.

The schema is owned by `migrations/`. To inspect the local database:

```sh
npx wrangler d1 execute url-shortener-db --local --command "SELECT * FROM links"
```

## Test

```sh
npm test             # vitest in the Workers runtime, schema built from migrations/
npm run typecheck
```

## Routes

| Route | Result |
|---|---|
| `GET /` | Create form and every link with its code, original URL and click count, newest first |
| `POST /links` (form field `url`) | `303` to `/?created=<code>`; `400` page with the error on invalid input |
| `GET /<code>` | `302` to the original URL and counts the click; `404` page for unknown codes |

Validation: only `http`/`https`, normalized URL at most 2048 characters, no links to the shortener's own host.
Any storage failure returns a `500` error page; nothing reports success after a failed write.

## Known limitations

- Self-link detection compares the target's host with the host the request arrived on. Aliases of the
  same server are not caught: when browsing via `localhost:8787`, a link to `127.0.0.1:8787` or
  `[::1]:8787` is accepted.
- Loops or chains through other URL shorteners (a short link pointing at another service's short link
  that points back here) are not detected; that would require following redirects at creation time.
- No authentication or rate limiting: anyone who can reach the app can create and list links.
