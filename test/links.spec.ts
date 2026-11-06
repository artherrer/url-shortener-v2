import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const BASE = 'https://short.test';
const CODE_SHAPE = /^[A-Za-z0-9]{7}$/;
const db = env.url_shortener_db;

function create(url: string, base = BASE) {
	return SELF.fetch(`${base}/links`, { method: 'POST', body: new URLSearchParams({ url }), redirect: 'manual' });
}

function visit(code: string) {
	return SELF.fetch(`${BASE}/${code}`, { redirect: 'manual' });
}

async function seed(code: string, url: string, clicks = 0, createdAt?: string) {
	if (createdAt) {
		await db.prepare('INSERT INTO links (code, url, clicks, created_at) VALUES (?, ?, ?, ?)').bind(code, url, clicks, createdAt).run();
	} else {
		await db.prepare('INSERT INTO links (code, url, clicks) VALUES (?, ?, ?)').bind(code, url, clicks).run();
	}
}

function getRow(code: string) {
	return db.prepare('SELECT code, url, clicks FROM links WHERE code = ?').bind(code).first<{ code: string; url: string; clicks: number }>();
}

async function rowCount() {
	return (await db.prepare('SELECT COUNT(*) AS n FROM links').first<number>('n')) ?? 0;
}

function createdCode(res: Response): string {
	const location = res.headers.get('Location');
	expect(location).not.toBeNull();
	const code = new URL(location!, BASE).searchParams.get('created');
	expect(code).toMatch(CODE_SHAPE);
	return code!;
}

/** The rendered <tr> for a code in the list page. */
function rowHtml(page: string, code: string): string | undefined {
	return page.match(new RegExp(`<tr data-code="${code}">[\\s\\S]*?</tr>`))?.[0];
}

/** Call the worker directly with a D1 binding whose every query rejects. */
async function fetchWithFailingDb(request: Request) {
	const fail = () => Promise.reject(new Error('D1_ERROR: simulated storage failure'));
	const stmt: Record<string, unknown> = { first: fail, all: fail, run: fail, raw: fail };
	stmt.bind = () => stmt;
	const failingDb = { prepare: () => stmt, batch: fail, exec: fail } as unknown as D1Database;
	return callWorker(request, { ...env, url_shortener_db: failingDb });
}

/** Unit-style call into the worker, for tests that need a custom env or module-level spies. */
function callWorker(request: Request, workerEnv: Env = env) {
	return worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, workerEnv);
}

beforeEach(async () => {
	await db.prepare('DELETE FROM links').run();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// Requirement 1: create a short link.
describe('POST /links', () => {
	it('stores the URL under a new 7-char code and redirects back with ?created=', async () => {
		const res = await create('https://example.com/some/long/path?x=1');

		expect(res.status).toBe(303);
		const code = createdCode(res);
		expect(await getRow(code)).toEqual({ code, url: 'https://example.com/some/long/path?x=1', clicks: 0 });
	});

	it('gives the same URL a different code each time', async () => {
		const a = createdCode(await create('https://example.com/'));
		const b = createdCode(await create('https://example.com/'));

		expect(a).not.toBe(b);
		expect(await rowCount()).toBe(2);
	});

	it('stores the normalized href', async () => {
		const code = createdCode(await create('  HTTPS://Example.COM  '));
		expect((await getRow(code))?.url).toBe('https://example.com/');
	});
});

// Requirement 6: server-side validation, errors shown in the UI, nothing stored.
describe('POST /links validation', () => {
	it.each([
		['empty', '', 'Enter a URL'],
		['whitespace only', '   ', 'Enter a URL'],
		['not a URL', 'not a url', 'not a valid URL'],
		['javascript: scheme', 'javascript:alert(1)', 'Only http:// and https://'],
		['data: scheme', 'data:text/html,hi', 'Only http:// and https://'],
		['ftp: scheme', 'ftp://example.com/file', 'Only http:// and https://'],
		['no host', 'http://', 'not a valid URL'],
	])('rejects %s with 400 and an error message', async (_name, input, message) => {
		const res = await create(input);

		expect(res.status).toBe(400);
		const page = await res.text();
		expect(page).toMatch(/role="alert"/);
		expect(page).toContain(message);
		expect(await rowCount()).toBe(0);
	});

	it('rejects a missing url field', async () => {
		const res = await SELF.fetch(`${BASE}/links`, { method: 'POST', body: new URLSearchParams({ other: 'x' }), redirect: 'manual' });

		expect(res.status).toBe(400);
		expect(await res.text()).toContain('Enter a URL');
		expect(await rowCount()).toBe(0);
	});

	it('rejects a body that is not form data', async () => {
		const res = await SELF.fetch(`${BASE}/links`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com' }),
			redirect: 'manual',
		});

		expect(res.status).toBe(400);
		expect(await res.text()).toMatch(/role="alert"/);
		expect(await rowCount()).toBe(0);
	});

	it('echoes the rejected input back escaped', async () => {
		const page = await (await create('"><script>alert(1)</script>')).text();

		expect(page).not.toContain('<script>alert(1)</script>');
		expect(page).toContain('&quot;&gt;&lt;script&gt;');
	});

	// The limit applies to the normalized href, not the typed input.
	it('accepts an href of exactly 2048 characters', async () => {
		const url = 'https://example.com/' + 'a'.repeat(2028);
		expect(url).toHaveLength(2048);

		expect((await create(url)).status).toBe(303);
	});

	it('rejects an href of 2049 characters', async () => {
		const res = await create('https://example.com/' + 'a'.repeat(2029));

		expect(res.status).toBe(400);
		expect(await res.text()).toContain('too long');
		expect(await rowCount()).toBe(0);
	});

	it('rejects input under 2048 chars that grows past 2048 once percent-encoded', async () => {
		const input = 'https://example.com/' + 'é'.repeat(700);
		expect(input.length).toBeLessThan(2048);
		expect(new URL(input).href.length).toBeGreaterThan(2048);

		const res = await create(input);

		expect(res.status).toBe(400);
		expect(await res.text()).toContain('too long');
		expect(await rowCount()).toBe(0);
	});

	// Self-referencing links would allow redirect chains and loops that inflate click counts.
	it.each([
		['same host', 'https://short.test/abc1234'],
		['different scheme, same host', 'http://short.test/abc1234'],
		['uppercase host', 'https://SHORT.TEST/abc1234'],
		['explicit default port', 'https://short.test:443/abc1234'],
		['trailing dot', 'https://short.test./abc1234'],
	])('rejects a link to this shortener (%s)', async (_name, input) => {
		const res = await create(input);

		expect(res.status).toBe(400);
		expect(await res.text()).toContain('this shortener');
		expect(await rowCount()).toBe(0);
	});

	it('allows the same hostname on a different port', async () => {
		expect((await create('https://short.test:8443/app')).status).toBe(303);
	});

	it('compares against the host of the incoming request', async () => {
		const res = await create('http://localhost:8787/abc1234', 'http://localhost:8787');
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('this shortener');
	});
});

// Concurrency: uniqueness comes from the primary key, never from check-then-insert.
describe('code collisions', () => {
	/** Make every generated code `char` repeated: bytes are mapped b % 62 onto A-Za-z0-9. */
	function forceCodes(...chars: number[]) {
		const spy = vi.spyOn(crypto, 'getRandomValues');
		let call = 0;
		spy.mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
			const value = chars[Math.min(call++, chars.length - 1)];
			(array as unknown as Uint8Array).fill(value);
			return array;
		});
		return spy;
	}

	function createDirect(url: string) {
		return callWorker(new Request(`${BASE}/links`, { method: 'POST', body: new URLSearchParams({ url }), redirect: 'manual' }));
	}

	it('retries with a new code and never overwrites the existing link', async () => {
		await seed('AAAAAAA', 'https://original.example/', 3);
		forceCodes(0, 1); // first attempt AAAAAAA (taken), second BBBBBBB

		const res = await createDirect('https://newcomer.example/');

		expect(res.status).toBe(303);
		expect(createdCode(res)).toBe('BBBBBBB');
		expect(await getRow('AAAAAAA')).toEqual({ code: 'AAAAAAA', url: 'https://original.example/', clicks: 3 });
		expect(await getRow('BBBBBBB')).toEqual({ code: 'BBBBBBB', url: 'https://newcomer.example/', clicks: 0 });
	});

	it('gives up with 500 after 5 colliding attempts and changes nothing', async () => {
		await seed('AAAAAAA', 'https://original.example/', 3);
		const spy = forceCodes(0);

		const res = await createDirect('https://newcomer.example/');

		expect(res.status).toBe(500);
		expect(res.headers.get('Location')).toBeNull();
		expect(spy).toHaveBeenCalledTimes(5);
		expect(await rowCount()).toBe(1);
		expect(await getRow('AAAAAAA')).toEqual({ code: 'AAAAAAA', url: 'https://original.example/', clicks: 3 });
	});
});

// Requirements 2 and 3: redirect and click count.
describe('GET /:code', () => {
	it('redirects with 302 (not cacheable 301) to the original URL', async () => {
		await seed('abc1234', 'https://example.com/target');

		const res = await visit('abc1234');

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe('https://example.com/target');
		expect(res.headers.get('Cache-Control')).toContain('no-store');
	});

	it('increments the click count on each redirect', async () => {
		await seed('abc1234', 'https://example.com/');

		await visit('abc1234');
		await visit('abc1234');

		expect((await getRow('abc1234'))?.clicks).toBe(2);
	});

	it('does not lose clicks under concurrent redirects', async () => {
		await seed('abc1234', 'https://example.com/');

		const responses = await Promise.all(Array.from({ length: 20 }, () => visit('abc1234')));

		expect(responses.map((r) => r.status)).toEqual(Array(20).fill(302));
		expect((await getRow('abc1234'))?.clicks).toBe(20);
	});

	it.each([
		['unknown code', '/zzzzzzz'],
		['wrong-length code', '/abc'],
		['nested path', '/abc1234/extra'],
	])('returns an HTML 404 page for %s and counts nothing', async (_name, path) => {
		await seed('abc1234', 'https://example.com/', 5);

		const res = await SELF.fetch(`${BASE}${path}`, { redirect: 'manual' });

		expect(res.status).toBe(404);
		expect(res.headers.get('Content-Type')).toContain('text/html');
		expect(await res.text()).toContain('Link not found');
		expect((await getRow('abc1234'))?.clicks).toBe(5);
	});
});

// Requirement 4: list every link.
describe('GET /', () => {
	it('shows every link with its code, original URL and click count', async () => {
		await seed('aaaaaa1', 'https://one.example/', 5);
		await seed('bbbbbb2', 'https://two.example/path', 0);

		const res = await SELF.fetch(BASE);
		const page = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toContain('text/html');
		const one = rowHtml(page, 'aaaaaa1');
		const two = rowHtml(page, 'bbbbbb2');
		expect(one).toContain('https://one.example/');
		expect(one).toContain('<td class="clicks">5</td>');
		expect(two).toContain('https://two.example/path');
		expect(two).toContain('<td class="clicks">0</td>');
	});

	it('lists newest first, breaking created_at ties by insertion order', async () => {
		const sameTime = '2026-01-01T00:00:00.000Z';
		await seed('first01', 'https://one.example/', 0, sameTime);
		await seed('second2', 'https://two.example/', 0, sameTime);
		await seed('older03', 'https://old.example/', 0, '2025-01-01T00:00:00.000Z');

		const page = await (await SELF.fetch(BASE)).text();

		const order = ['second2', 'first01', 'older03'].map((code) => page.indexOf(`data-code="${code}"`));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it('escapes stored URLs', async () => {
		await seed('xss0001', 'https://example.com/?q=<b>x</b>"');

		const page = await (await SELF.fetch(BASE)).text();

		expect(page).not.toContain('<b>x</b>');
		expect(rowHtml(page, 'xss0001')).toContain('https://example.com/?q=&lt;b&gt;x&lt;/b&gt;&quot;');
	});

	it('shows the created banner only for an existing code', async () => {
		await seed('abc1234', 'https://example.com/');

		const page = await (await SELF.fetch(`${BASE}/?created=abc1234`)).text();

		expect(page).toMatch(/<p class="created"[^>]*>[\s\S]*abc1234/);
	});

	it.each([
		['markup', '<script>alert(1)</script>'],
		['well-formed but unknown code', 'zzzzzzz'],
	])('does not reflect ?created= for %s', async (_name, value) => {
		const page = await (await SELF.fetch(`${BASE}/?created=${encodeURIComponent(value)}`)).text();

		expect(page).not.toContain('class="created"');
		expect(page).not.toContain(value);
		expect(page).not.toContain(value.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
	});
});

describe('method handling', () => {
	it('returns 405 for unsupported methods', async () => {
		const res = await SELF.fetch(BASE, { method: 'PUT' });
		expect(res.status).toBe(405);
	});
});

// Storage failures must surface as errors, never as a fake success.
describe('when D1 fails', () => {
	it('create returns 500 with an error page and no redirect', async () => {
		const res = await fetchWithFailingDb(
			new Request(`${BASE}/links`, { method: 'POST', body: new URLSearchParams({ url: 'https://example.com/' }), redirect: 'manual' }),
		);

		expect(res.status).toBe(500);
		expect(res.headers.get('Location')).toBeNull();
		const page = await res.text();
		expect(page).toMatch(/role="alert"/);
		expect(page).toContain('Could not save the link');
	});

	it('redirect returns 500 with an error page and no redirect', async () => {
		const res = await fetchWithFailingDb(new Request(`${BASE}/abc1234`, { redirect: 'manual' }));

		expect(res.status).toBe(500);
		expect(res.headers.get('Location')).toBeNull();
		expect(await res.text()).toContain('Could not load this link');
	});

	it('list returns 500 with an error page', async () => {
		const res = await fetchWithFailingDb(new Request(BASE));

		expect(res.status).toBe(500);
		expect(await res.text()).toContain('Could not load links');
	});
});
