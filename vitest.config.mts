import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
	// Tests build their schema from the same migration files used by `wrangler dev`.
	const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
			}),
		],
		test: { setupFiles: ['./test/apply-migrations.ts'] },
	};
});
