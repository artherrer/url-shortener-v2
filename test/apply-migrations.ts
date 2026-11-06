import { applyD1Migrations, env } from 'cloudflare:test';

// Idempotent: migrations already recorded in d1_migrations are skipped.
await applyD1Migrations(env.url_shortener_db, env.TEST_MIGRATIONS);
