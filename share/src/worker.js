// Share work with clients (FEATURE-SPECS 3). One Cloudflare Worker serves the shared pages from ./public and keeps
// clients' notes in D1. Every shared project lives under an unguessable folder (/<id>/); knowing the link is the
// access, for the page and for its notes, so Tris collects a project's notes with the same id.
const ID = /^\/[A-Za-z0-9_-]{16,}\//;
const PROJECT = /^\/[A-Za-z0-9_-]{16,}\/$/;
const LAYER = '<script src="/_notes/notes.js" defer></script>';

// Private links stay out of search engines and out of the Referer header sent to other sites.
function privately(response) {
  const out = new Response(response.body, response);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('Referrer-Policy', 'no-referrer');
  return out;
}
const json = (body, status = 200) => privately(Response.json(body, { status }));

// "/abc/" and "/abc/index.html" are the same page.
export const pageKey = (path) => path.replace(/\/index\.html?$/i, '/');

export async function notes(request, env, url) {
  if (request.method === 'GET') {
    const page = url.searchParams.get('page'), project = url.searchParams.get('project');
    const since = Number(url.searchParams.get('since') || 0) || 0;
    if (page && ID.test(page) && page.length <= 300) {
      const { results } = await env.NOTES.prepare('SELECT * FROM notes WHERE page = ? ORDER BY created').bind(pageKey(page)).all();
      return json(results);
    }
    if (project && PROJECT.test(project)) {
      const { results } = await env.NOTES.prepare('SELECT * FROM notes WHERE page >= ? AND page < ? AND created > ? ORDER BY created')
        .bind(project, project + '￿', since).all();
      return json(results);
    }
    return json({ error: 'Name a shared page or project.' }, 400);
  }
  if (request.method !== 'POST') return json({ error: 'Use GET or POST.' }, 405);
  // ponytail: no rate limit; a link holder could post many notes. Add one per-IP limit if a link leaks.
  const raw = await request.text();
  if (raw.length > 10000) return json({ error: 'That note is too long.' }, 413);
  let n;
  try { n = JSON.parse(raw); } catch { return json({ error: 'Send the note as JSON.' }, 400); }
  const text = String(n.text || '').trim(), name = String(n.name || '').trim(), page = pageKey(String(n.page || ''));
  if (!text || text.length > 4000) return json({ error: 'Write a note of up to 4,000 characters.' }, 400);
  if (!name || name.length > 60) return json({ error: 'Add your name (up to 60 characters).' }, 400);
  if (!ID.test(page) || page.length > 300) return json({ error: 'This page cannot take notes.' }, 400);
  const asset = await env.ASSETS.fetch(new Request(new URL(page, url.origin)));
  if (!asset.ok) return json({ error: 'This page cannot take notes.' }, 404);
  const num = (v) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : null);
  const note = {
    id: crypto.randomUUID(), page, anchor: String(n.anchor || '').slice(0, 600) || null,
    fx: num(n.fx), fy: num(n.fy), px: num(n.px), py: num(n.py), text, name, created: Date.now(),
  };
  await env.NOTES.prepare('INSERT INTO notes (id, page, anchor, fx, fy, px, py, text, name, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(note.id, note.page, note.anchor, note.fx, note.fy, note.px, note.py, note.text, note.name, note.created).run();
  return json(note, 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/notes') return notes(request, env, url);
    // Nothing lists the shared folders.
    if (!ID.test(url.pathname) && !url.pathname.startsWith('/_notes/')) return privately(new Response('Not found', { status: 404 }));
    const response = await env.ASSETS.fetch(request);
    if (!(response.headers.get('content-type') || '').includes('text/html')) return privately(response);
    // The notes layer goes on every shared page without touching the page's own files.
    return privately(new HTMLRewriter().on('body', { element(el) { el.append(LAYER, { html: true }); } }).transform(response));
  },
};
