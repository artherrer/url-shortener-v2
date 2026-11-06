import { createLink, listLinks, recordClick, SHORT_PATH_PATTERN, validateAlias, validateUrl, type Link } from './links';
import type { RoutePath } from './routes';
import { homePage, html, messagePage, type HomeView } from './views';

type Handler = (request: Request, db: D1Database, url: URL) => Promise<Response>;

// Must list exactly ROUTE_PATHS (checked by `satisfies`); those paths are reserved as aliases.
const routes = {
	'/': { GET: (_request, db, url) => home(db, url) },
	'/links': { POST: create },
} satisfies Record<RoutePath, Record<string, Handler>>;

/**
 * Status rule: client mistakes are 4xx (400 invalid input, 404 unknown code, 405 wrong method).
 * Any failure on our side, including every D1 error, is 500 with an error page: a D1 exception
 * does not tell us whether retrying will help, so we do not promise that with 503.
 */
export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const db = env.url_shortener_db;

		if (Object.hasOwn(routes, url.pathname)) {
			const route: Record<string, Handler> = routes[url.pathname as RoutePath];
			const handler = Object.hasOwn(route, request.method) ? route[request.method] : undefined;
			return handler ? handler(request, db, url) : methodNotAllowed(Object.keys(route).join(', '));
		}

		const code = url.pathname.slice(1);
		if (!SHORT_PATH_PATTERN.test(code)) return notFound();
		if (request.method !== 'GET') return methodNotAllowed('GET');
		return follow(db, code);
	},
} satisfies ExportedHandler<Env>;

function home(db: D1Database, url: URL): Promise<Response> {
	return renderHome(db, url, { createdCode: url.searchParams.get('created') }, 200);
}

async function create(request: Request, db: D1Database, url: URL): Promise<Response> {
	let input: string | null;
	let aliasInput: string | null;
	try {
		const form = await request.formData();
		input = formString(form, 'url');
		aliasInput = formString(form, 'alias');
	} catch {
		return renderHome(db, url, { error: { field: 'url', message: 'Submit the form with a url field.' } }, 400);
	}
	const kept = { input: input ?? '', aliasInput: aliasInput ?? '' };

	const target = validateUrl(input, url.host);
	if (!target.ok) return renderHome(db, url, { ...kept, error: { field: 'url', message: target.error } }, 400);
	const alias = validateAlias(aliasInput);
	if (!alias.ok) return renderHome(db, url, { ...kept, error: { field: 'alias', message: alias.error } }, 400);

	let result: Awaited<ReturnType<typeof createLink>>;
	try {
		result = await createLink(db, target.url, alias.alias);
	} catch (error) {
		console.error('Failed to create link', error);
		return serverError('Could not save the link. Please try again.');
	}
	if (!result.ok) {
		return renderHome(db, url, { ...kept, error: { field: 'alias', message: 'That alias is already taken. Choose another one.' } }, 409);
	}
	// 303 so reloading the result page does not resubmit the form.
	return new Response(null, { status: 303, headers: { Location: `/?created=${encodeURIComponent(result.code)}` } });
}

function formString(form: FormData, name: string): string | null {
	const value = form.get(name);
	return typeof value === 'string' ? value : null;
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

interface HomeState extends Pick<HomeView, 'error' | 'input' | 'aliasInput'> {
	/** Untrusted ?created= value; the banner only shows a link that exists in D1. */
	createdCode?: string | null;
}

async function renderHome(db: D1Database, url: URL, { createdCode, ...form }: HomeState, status: number): Promise<Response> {
	let links: Link[];
	try {
		links = await listLinks(db);
	} catch (err) {
		console.error('Failed to list links', err);
		return serverError('Could not load links. Please try again.');
	}
	const created = createdCode ? links.find((link) => link.code === createdCode) : undefined;
	return html(homePage({ ...form, origin: url.origin, links, created }), status);
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
