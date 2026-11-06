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
| `POST /links` (form fields `url`, optional `alias`) | `303` to `/?created=<code>`; `400` page on invalid input; `409` if the alias is taken. Both inputs are kept on re-render |
| `GET /<code>` | `302` to the original URL and counts the click (code matched ignoring case); `404` page for unknown codes |

Validation: only `http`/`https`, normalized URL at most 2048 characters, no links to the shortener's own host.
Any storage failure returns a `500` error page; nothing reports success after a failed write.

## Added feature: custom aliases

The form takes an optional alias, so a link can be `/summer-sale` instead of a random code.

- **Format:** 3 to 32 letters, digits or hyphens, not starting or ending with a hyphen. Generated codes
  (7 letters/digits) fit the same pattern, so the router has one rule for both.
- **Reserved:** every fixed route (`/links`) and `api`, `admin`, `assets`, `static`, `new`, `cdn-cgi`,
  ignoring case. The router's table is typed against `ROUTE_PATHS` in `src/routes.ts`, so adding a route
  without listing it there fails `npm run typecheck`; listing it there reserves it.
- **Case-insensitive uniqueness:** `Promo` and `promo` are the same alias, because people retype links
  with the wrong case. Migration `0002` adds a unique `COLLATE NOCASE` index (see the comment there for
  why not rebuilding the table). Aliases are stored as typed and `/PROMO` resolves `Promo`.
- **No check-then-insert:** aliases and generated codes use the same
  `INSERT … ON CONFLICT DO NOTHING RETURNING code`. No returned row means the code is taken: a taken alias
  is a `409`, a generated code is retried with a new one (up to 5 times).

Why this feature: it is the same conflict problem as generated codes, but now the user sees it, which
makes it a direct test of the uniqueness handling.

## Timeline

- Planning started at 13:00, before the first commit.
- 13:05 first commit (scaffold).
- 13:31 core done (create, redirect, click count, list, validation, D1 persistence).
- 13:42 custom aliases done.

## What I'd do next

- Run `npm run typecheck` alongside `npm test` in CI: the route/alias guard is a compile-time check.
- Rate limiting and an owner per link before exposing it anywhere public.
- A way to delete or edit a link, which would need the same care about who may change which alias.

## Known limitations

- Self-link detection compares the target's host with the host the request arrived on. Aliases of the
  same server are not caught: when browsing via `localhost:8787`, a link to `127.0.0.1:8787` or
  `[::1]:8787` is accepted.
- Loops or chains through other URL shorteners (a short link pointing at another service's short link
  that points back here) are not detected; that would require following redirects at creation time.
- No authentication or rate limiting: anyone who can reach the app can create and list links.
- An alias created before a route of the same name is added would be shadowed by that route. Whoever
  adds a route must check for an existing alias first:
  `SELECT code FROM links WHERE code = '<name>' COLLATE NOCASE`.
- The concurrent-alias test only proves the guard when the two requests overlap. Locally, D1 handled
  them one after the other, so a check-then-insert version still passed it (even with 10 racers); it
  only failed once a delay was forced between the check and the insert. The real guarantee is the
  unique index plus `ON CONFLICT DO NOTHING`, which does not depend on timing.
