// Share work with clients (FEATURE-SPECS 3). One Cloudflare Worker serves the shared pages from ./public and keeps
// clients' notes in D1. Every shared project lives under an unguessable folder (/<id>/); knowing the link is the
// access, for the page and for its notes, so Tris collects a project's notes with the same id. A project can also
// have a password (3.2); its "for your AI" address then carries its own key, since an AI cannot type a password (3.7).
const ID = /^\/[A-Za-z0-9_-]{16,}\//;
const PROJECT = /^\/[A-Za-z0-9_-]{16,}\/$/;
const projectOf = (path) => (ID.exec(path) || [''])[0];

// Private links stay out of search engines and out of the Referer header sent to other sites.
function privately(response) {
  const out = new Response(response.body, response);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  out.headers.set('Referrer-Policy', 'no-referrer');
  return out;
}
const json = (body, status = 200) => privately(Response.json(body, { status }));
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// "/abc/" and "/abc/index.html" are the same page.
export const pageKey = (path) => path.replace(/\/index\.html?$/i, '/');

// Tris writes each project's settings next to its pages (version, password hash, AI key); never served as a file.
export async function shareOf(env, origin, project) {
  if (!project) return {};
  const response = await env.ASSETS.fetch(new Request(new URL(project + '_share.json', origin)));
  if (!response.ok) return {};
  try { return await response.json(); } catch { return {}; }
}

// The same derivation Tris uses when Koan sets a password (PBKDF2, SHA-256, 100,000 rounds, the Workers maximum).
export async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const cookieName = (project) => 'share_' + project.slice(1, -1);
// ponytail: plain string compares; constant-time compares if a link is ever attacked by timing.
export function allowed(request, url, share, project) {
  if (!share.password) return true;
  if (share.aiKey && url.searchParams.get('key') === share.aiKey) return true;
  const name = cookieName(project) + '=';
  const cookie = (request.headers.get('cookie') || '').split(/;\s*/).find((part) => part.startsWith(name));
  return !!cookie && cookie.slice(name.length) === share.password.hash;
}
const lockPage = (project, wrong) => privately(new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private page</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141413;color:#e8e6dc;font:15px system-ui,sans-serif}form{display:grid;gap:10px;width:min(320px,calc(100vw - 32px))}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #30302d;background:#20201e;color:#e8e6dc}button{background:#d29a7e;color:#141413;border-color:#d29a7e;cursor:pointer}p{margin:0;color:#e57f77;font-size:13px}</style>
<form method="post" action="${escape(project)}_unlock"><label for="p">This page is private. Enter its password.</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus required>${wrong ? '<p role="alert">That password is not right.</p>' : ''}<button>Open</button></form>`, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } }));

export async function notes(request, env, url) {
  if (request.method === 'GET') {
    const page = url.searchParams.get('page'), project = url.searchParams.get('project');
    const since = Number(url.searchParams.get('since') || 0) || 0;
    const owner = page && ID.test(page) && page.length <= 300 ? projectOf(page) : project && PROJECT.test(project) ? project : '';
    if (!owner) return json({ error: 'Name a shared page or project.' }, 400);
    if (!allowed(request, url, await shareOf(env, url.origin, owner), owner)) return json({ error: 'This page is private.' }, 401);
    if (page) {
      const { results } = await env.NOTES.prepare('SELECT * FROM notes WHERE page = ? ORDER BY created').bind(pageKey(page)).all();
      return json(results);
    }
    const { results } = await env.NOTES.prepare('SELECT * FROM notes WHERE page >= ? AND page < ? AND created > ? ORDER BY created')
      .bind(project, project + '￿', since).all();
    return json(results);
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
  const share = await shareOf(env, url.origin, projectOf(page));
  if (!allowed(request, url, share, projectOf(page))) return json({ error: 'This page is private.' }, 401);
  const asset = await env.ASSETS.fetch(new Request(new URL(page, url.origin)));
  if (!asset.ok) return json({ error: 'This page cannot take notes.' }, 404);
  const num = (v) => (v != null && v !== '' && Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : null);
  const note = {
    id: crypto.randomUUID(), page, anchor: String(n.anchor || '').slice(0, 600) || null,
    fx: num(n.fx), fy: num(n.fy), px: num(n.px), py: num(n.py), text, name, created: Date.now(),
    version: Number.isInteger(share.version) ? share.version : null,
  };
  await env.NOTES.prepare('INSERT INTO notes (id, page, anchor, fx, fy, px, py, text, name, created, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(note.id, note.page, note.anchor, note.fx, note.fy, note.px, note.py, note.text, note.name, note.created, note.version).run();
  return json(note, 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/notes') return notes(request, env, url);
    if (url.pathname.startsWith('/_notes/')) return privately(await env.ASSETS.fetch(request));
    // Nothing lists the shared folders, and a project's settings file is never served.
    const project = projectOf(url.pathname);
    if (!project || url.pathname.endsWith('/_share.json')) return privately(new Response('Not found', { status: 404 }));
    const share = await shareOf(env, url.origin, project);
    if (request.method === 'POST' && url.pathname === project + '_unlock') {
      const form = await request.formData().catch(() => null), password = String(form?.get('password') || '');
      if (!share.password || !password || (await derive(password, share.password.salt)) !== share.password.hash) return lockPage(project, true);
      return privately(new Response(null, { status: 303, headers: { location: project, 'set-cookie': `${cookieName(project)}=${share.password.hash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000` } }));
    }
    if (!allowed(request, url, share, project)) return lockPage(project, false);
    // The "for your AI" address: plain text Koan approved (3.7).
    if (url.pathname === project + 'for-ai') {
      const text = await env.ASSETS.fetch(new Request(new URL(project + 'for-ai.txt', url.origin)));
      if (!text.ok) return privately(new Response('Not found', { status: 404 }));
      return privately(new Response(text.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    }
    const response = await env.ASSETS.fetch(request);
    if (!(response.headers.get('content-type') || '').includes('text/html')) return privately(response);
    // The notes layer goes on every shared page without touching the page's own files.
    const layer = `<script src="/_notes/notes.js" data-version="${Number.isInteger(share.version) ? share.version : 0}" defer></script>`;
    return privately(new HTMLRewriter().on('body', { element(el) { el.append(layer, { html: true }); } }).transform(response));
  },
};
