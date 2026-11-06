import { ROUTE_PATHS } from './routes';

export interface Link {
	code: string;
	url: string;
	clicks: number;
	created_at: string;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 7;
/** Any path segment that can name a link: custom aliases, with generated codes as a subset. */
export const SHORT_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{1,30}[A-Za-z0-9]$/;
// Fixed routes plus names kept free for future routes (cdn-cgi is used by Cloudflare). Compared ignoring case.
const RESERVED_ALIASES = new Set(
	[...ROUTE_PATHS.map((path) => path.slice(1)).filter(Boolean), 'api', 'admin', 'assets', 'static', 'new', 'cdn-cgi'].map((word) =>
		word.toLowerCase(),
	),
);
export const MAX_URL_LENGTH = 2048;
const MAX_CREATE_ATTEMPTS = 5;
// Largest multiple of 62 that fits in a byte; higher bytes are discarded so every character is equally likely.
const UNBIASED_BYTE_LIMIT = 256 - (256 % ALPHABET.length);

const INVALID_URL = 'That is not a valid URL. Include the scheme, for example https://example.com.';

export type UrlValidation = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validates user input as a shortenable URL and returns its normalized href.
 * `requestHost` is the host the shortener was reached on; links back to it are rejected
 * so short links cannot chain or loop through this service.
 */
export function validateUrl(input: string | null, requestHost: string): UrlValidation {
	const raw = (input ?? '').trim();
	if (!raw) return { ok: false, error: 'Enter a URL to shorten.' };

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, error: INVALID_URL };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, error: 'Only http:// and https:// URLs can be shortened.' };
	}
	if (!url.hostname) {
		return { ok: false, error: INVALID_URL };
	}
	// Checked after parsing: normalization (punycode, percent-encoding) can make the href longer than the input.
	if (url.href.length > MAX_URL_LENGTH) {
		return { ok: false, error: `That URL is too long: ${url.href.length} characters once normalized, the limit is ${MAX_URL_LENGTH}.` };
	}
	if (comparableHost(url.host) === comparableHost(requestHost)) {
		return { ok: false, error: 'Links to this shortener itself are not allowed.' };
	}
	return { ok: true, url: url.href };
}

/** URL already lowercases hosts and drops default ports; it keeps a trailing dot, which names the same host. */
function comparableHost(host: string): string {
	return host.toLowerCase().replace(/\.(:\d+)?$/, '$1');
}

export type AliasValidation = { ok: true; alias: string | null } | { ok: false; error: string };

/** An empty alias means "generate a code". */
export function validateAlias(input: string | null): AliasValidation {
	const alias = (input ?? '').trim();
	if (!alias) return { ok: true, alias: null };
	if (!SHORT_PATH_PATTERN.test(alias)) {
		return { ok: false, error: 'An alias is 3 to 32 letters, digits or hyphens, and cannot start or end with a hyphen.' };
	}
	if (RESERVED_ALIASES.has(alias.toLowerCase())) {
		return { ok: false, error: `"${alias}" is reserved. Choose another alias.` };
	}
	return { ok: true, alias };
}

export function generateCode(): string {
	let code = '';
	while (code.length < CODE_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
			if (byte < UNBIASED_BYTE_LIMIT && code.length < CODE_LENGTH) code += ALPHABET[byte % ALPHABET.length];
		}
	}
	return code;
}

export type CreateResult = { ok: true; code: string } | { ok: false; reason: 'alias-taken' };

/**
 * Inserts a link under `alias`, or under a fresh generated code when alias is null.
 * Uniqueness (ignoring case) is enforced by D1's indexes, never by a lookup first. ON CONFLICT
 * names no target so it covers every unique index: a conflicting insert returns no row and
 * never overwrites. A taken alias is reported to the caller; a generated code is retried.
 */
export async function createLink(db: D1Database, url: string, alias: string | null): Promise<CreateResult> {
	if (alias !== null) {
		const code = await insertLink(db, alias, url);
		return code ? { ok: true, code } : { ok: false, reason: 'alias-taken' };
	}
	for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
		const code = await insertLink(db, generateCode(), url);
		if (code) return { ok: true, code };
	}
	throw new Error(`No free short code after ${MAX_CREATE_ATTEMPTS} attempts`);
}

function insertLink(db: D1Database, code: string, url: string): Promise<string | null> {
	return db.prepare('INSERT INTO links (code, url) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING code').bind(code, url).first<string>('code');
}

/** Atomically counts a click and returns the target URL, or null if no code matches (ignoring case). */
export function recordClick(db: D1Database, code: string): Promise<string | null> {
	return db.prepare('UPDATE links SET clicks = clicks + 1 WHERE code = ? COLLATE NOCASE RETURNING url').bind(code).first<string>('url');
}

export async function listLinks(db: D1Database): Promise<Link[]> {
	const { results } = await db
		.prepare('SELECT code, url, clicks, created_at FROM links ORDER BY created_at DESC, rowid DESC')
		.all<Link>();
	return results;
}
