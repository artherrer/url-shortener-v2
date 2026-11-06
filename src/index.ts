import { CODE_PATTERN, createLink, listLinks, recordClick, validateUrl, type Link } from './links';
import { homePage, html, messagePage } from './views';

/**
 * Status rule: client mistakes are 4xx (400 invalid input, 404 unknown code, 405 wrong method).
 * Any failure on our side, including every D1 error, is 500 with an error page: a D1 exception
 * does not tell us whether retrying will help, so we do not promise that with 503.
 */
export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const db = env.url_shortener_db;

		if (url.pathname === '/') {
			if (request.method !== 'GET') return methodNotAllowed('GET');
			return home(db, url);
		}
		if (url.pathname === '/links') {
			if (request.method !== 'POST') return methodNotAllowed('POST');
			return create(request, db, url);
		}

		const code = url.pathname.slice(1);
		if (!CODE_PATTERN.test(code)) return notFound();
		if (request.method !== 'GET') return methodNotAllowed('GET');
		return follow(db, code);
	},
} satisfies ExportedHandler<Env>;

function home(db: D1Database, url: URL): Promise<Response> {
	return renderHome(db, url, { createdCode: url.searchParams.get('created') }, 200);
}

async function create(request: Request, db: D1Database, url: URL): Promise<Response> {
	let input: string | null;
	try {
		const value = (await request.formData()).get('url');
		input = typeof value === 'string' ? value : null;
	} catch {
		return renderHome(db, url, { error: 'Submit the form with a url field.' }, 400);
	}

	const result = validateUrl(input, url.host);
	if (!result.ok) return renderHome(db, url, { error: result.error, input: input ?? '' }, 400);

	let code: string;
	try {
		code = await createLink(db, result.url);
	} catch (error) {
		console.error('Failed to create link', error);
		return serverError('Could not save the link. Please try again.');
	}
	// 303 so reloading the result page does not resubmit the form.
	return new Response(null, { status: 303, headers: { Location: `/?created=${code}` } });
}

async function follow(db: D1Database, code: string): Promise<Response> {
	let target: string | null;
	try {
		target = await recordClick(db, code);
	} catch (error) {
		console.error('Failed to resolve link', code, error);
		return serverError('Could not load this link. Please try again.');
	}
	if (target === null) return notFound();
	// 302, not 301: a cached permanent redirect would skip the worker and stop counting clicks.
	return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'private, no-store' } });
}

interface HomeState {
	error?: string;
	input?: string;
	/** Untrusted ?created= value; the banner only shows a link that exists in D1. */
	createdCode?: string | null;
}

async function renderHome(db: D1Database, url: URL, { error, input, createdCode }: HomeState, status: number): Promise<Response> {
	let links: Link[];
	try {
		links = await listLinks(db);
	} catch (err) {
		console.error('Failed to list links', err);
		return serverError('Could not load links. Please try again.');
	}
	const created = createdCode ? links.find((link) => link.code === createdCode) : undefined;
	return html(homePage({ origin: url.origin, links, error, input, created }), status);
}

function notFound(): Response {
	return html(messagePage('Link not found', 'There is no short link with this code.'), 404);
}

function methodNotAllowed(allow: string): Response {
	return html(messagePage('Method not allowed', `This address only accepts ${allow} requests.`), 405, { Allow: allow });
}

function serverError(message: string): Response {
	return html(messagePage('Something went wrong', message), 500);
}
