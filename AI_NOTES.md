# AI notes

## Tools

- **Claude Code** for planning, tests, implementation, and the break checks (temporary changes that
  must make a test fail, shown as a diff plus failing output, then reverted and never committed).

## What was wrong in my first version, and why I redid it

- Swallowed D1 errors: the catch logged the error and still returned success.
- An in-memory fallback, which made a second source of truth next to D1.
- Check-then-insert on aliases (`exists()` then `INSERT`): two requests could claim the same alias.
- Random codes were never checked for collisions.
- Tests ran against a remote D1.

## Most important exchanges

- **Plan review before any code.** The data model, API, failure modes and a test plan mapping each test
  to a requirement were agreed before any file was touched. Each test came with the break that
  must make it fail.
- **The test 11 change.** The first plan proved error handling by removing the try/catch. I changed it to
  the bug I actually had: a catch that logs and still returns `303` (or `302` on a redirect). The test now
  asserts `500` and no `Location` header.

## What the AI got wrong, and how it was caught

- **The retry-forever test hung instead of failing.** With an unbounded retry loop, the whole vitest run hung
  and produced no result. It was caught while running the break checks. Fix: the fake random generator throws after
  10 calls, so the test now fails with `expected 5 calls, got 11`.
- **A vague claim about `ON CONFLICT (code)`.** Claude Code said it "behaved in a way I wouldn't rely on".
  I asked for exactly what it saw. Rerun on its own: `(code)` without a collation matched the NOCASE index,
  so DO NOTHING applied (no error, no row). Only `(code COLLATE BINARY)` raised `UNIQUE constraint failed`.
- **The reviewer's guess was wrong too.** It predicted that `ON CONFLICT (code)` would miss the NOCASE
  conflict and return a 500. Checked against local D1 as a break: all 72 tests still passed, so it is not a
  break. The 500 only happens with `(code COLLATE BINARY)`, which is now one of the break checks for Promo/promo.
- **A guard that could never run.** Claude Code proposed skipping reserved words for generated codes.
  A generated code is always 7 letters or digits, and no reserved word has that shape. I asked for it to be
  dropped, and it was.
- Minor: the custom-alias test commit (`25cf167`) does not pass the typecheck until `src/routes.ts`
  lands in the next commit.

## Decisions I accepted on purpose

- **Primary key + `ON CONFLICT DO NOTHING RETURNING`, never check-then-insert.** D1 enforces uniqueness in a
  single statement. No returned row means the code is taken: a generated code is retried, a taken
  alias is a 409. It never overwrites (`INSERT OR REPLACE` was ruled out).
- **Atomic `UPDATE … SET clicks = clicks + 1 … RETURNING url`.** The lookup and the increment are one
  statement, and the count is never read into JavaScript and written back. Proven: the read-then-write
  version recorded 20 concurrent clicks as 2.
- **An extra NOCASE unique index instead of rebuilding the table.** SQLite can't change a column's
  collation in place, so a rebuild means create/copy/drop/rename. The index adds nothing destructive and fails
  cleanly if case duplicates exist. The cost is two indexes on `code`.
- **The 500 rule.** Client mistakes are 4xx. Every failure on our side, including every D1 error, is 500.
  A D1 exception doesn't say whether a retry would help, so we don't promise that with a 503.
- **D1 is the only source of truth.** There is no in-memory state, and the schema comes only from
  migrations, with the same files for dev and tests.

## Risks, by impact

1. **The race tests don't reproduce the race locally.** Check-then-insert on aliases passed the
   concurrent test, even with 10 requests at once, because local D1 handled them one after the other. It failed
   only with a forced 20 ms delay between the check and the insert. The guarantee rests on the database
   constraint, not on the test. (The click-count race did reproduce.)
2. **No authentication or rate limiting.** Anyone who can reach the app can create and list links.
3. **The route/alias guard is a compile-time check.** A new route that isn't listed in `ROUTE_PATHS` only
   fails `npm run typecheck`, not `npm test`. CI has to run both.
4. **An alias created before a route of the same name is added** would be hidden by that route. Whoever adds
   the route has to check the database first.
5. **Self-link detection misses other names for the same server.** `127.0.0.1` and `[::1]` aren't caught when
   browsing via `localhost`, and neither are loops through other shorteners.
