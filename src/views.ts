import type { Link } from './links';

export function escapeHtml(value: string | number): string {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function html(body: string, status = 200, headers: HeadersInit = {}): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
}

function layout(title: string, content: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
	body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; }
	form { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
	input[type=url] { flex: 1 1 20rem; padding: .5rem; font: inherit; }
	button { padding: .5rem 1rem; font: inherit; }
	.error { color: #a40000; background: #fdecec; padding: .5rem .75rem; border-radius: 4px; }
	.created { background: #e8f5e9; padding: .5rem .75rem; border-radius: 4px; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: .4rem; border-bottom: 1px solid #ddd; vertical-align: top; }
	td.url { word-break: break-all; }
	td.clicks { text-align: right; }
</style>
</head>
<body>
${content}
</body>
</html>`;
}

export interface HomeView {
	origin: string;
	links: Link[];
	error?: string;
	input?: string;
	created?: Link;
}

export function homePage({ origin, links, error, input, created }: HomeView): string {
	const shortUrl = (code: string) => `${origin}/${code}`;
	const banner = created
		? `<p class="created" role="status">Short link created: <a href="/${escapeHtml(created.code)}">${escapeHtml(shortUrl(created.code))}</a></p>`
		: '';
	const alert = error ? `<p class="error" id="url-error" role="alert">${escapeHtml(error)}</p>` : '';
	const rows = links
		.map(
			(link) => `<tr data-code="${escapeHtml(link.code)}">
<td><a href="/${escapeHtml(link.code)}">${escapeHtml(link.code)}</a></td>
<td class="url"><a href="${escapeHtml(link.url)}" rel="noopener noreferrer">${escapeHtml(link.url)}</a></td>
<td class="clicks">${escapeHtml(link.clicks)}</td>
</tr>`,
		)
		.join('\n');

	return layout(
		'URL shortener',
		`<h1>URL shortener</h1>
<form method="post" action="/links">
	<label for="url">Long URL</label>
	<input type="url" id="url" name="url" required placeholder="https://example.com/a/long/path" value="${escapeHtml(input ?? '')}"${error ? ' aria-invalid="true" aria-describedby="url-error"' : ''}>
	<button type="submit">Shorten</button>
</form>
${alert}
${banner}
<h2>Links</h2>
${
	links.length
		? `<table>
<thead><tr><th scope="col">Short code</th><th scope="col">Original URL</th><th scope="col">Clicks</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`
		: '<p>No links yet.</p>'
}`,
	);
}

export function messagePage(title: string, message: string, role: 'alert' | 'status' = 'alert'): string {
	return layout(title, `<h1>${escapeHtml(title)}</h1>\n<p role="${role}">${escapeHtml(message)}</p>\n<p><a href="/">Back to all links</a></p>`);
}
