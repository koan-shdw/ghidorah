// Share work with clients (FEATURE-SPECS 3). One Cloudflare Worker serves the shared pages from ./public and keeps
// clients' notes in D1. Every shared project lives under an unguessable folder (/<id>/); knowing the link is the
// access, for the page and for its notes, so Tris collects a project's notes with the same id. A project can also
// have a password (3.2); its "for your AI" address then carries its own key, since an AI cannot type a password (3.7).
//
// Koan's preview pages (FEATURE-SPECS 4), like Claude Code's artifacts: private until he shares them. The site knows
// him by a key only Tris holds (its SHA-256 is in /_owner.json, never served), which Tris sends as a bearer token and
// never puts in an address. To open a page as him, Tris asks for a one-time sign-in code (two minutes); the address
// with ?login=<code> gives that browser its own session cookie and drops the code. A page's settings live in D1, so
// renaming, sharing, pinning and deleting work from the web without a deploy; its files stay in ./public under a
// folder Tris writes. The page runs in a sandboxed frame from an address that carries the page's own token.
import { viewer, home, manifest, markdownOf, slug, SANDBOX } from './pages.js';

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
const html = (body, status = 200) => privately(new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }));
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const notFound = () => privately(new Response('Not found', { status: 404 }));
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const randomId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const readCookie = (request, name) => {
  const part = (request.headers.get('cookie') || '').split(/;\s*/).find((p) => p.startsWith(name + '='));
  return part ? part.slice(name.length + 1) : '';
};

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
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256));
}
const cookieName = (project) => 'share_' + project.slice(1, -1);
const unlockCookie = (name, hash) => `${name}=${hash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
// ponytail: plain string compares; constant-time compares if a link is ever attacked by timing.
export function allowed(request, url, share, project) {
  if (!share.password) return true;
  if (share.aiKey && url.searchParams.get('key') === share.aiKey) return true;
  return readCookie(request, cookieName(project)) === share.password.hash;
}
const lockPage = (project, wrong) => privately(new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private page</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#141413;color:#e8e6dc;font:15px system-ui,sans-serif}form{display:grid;gap:10px;width:min(320px,calc(100vw - 32px))}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #30302d;background:#20201e;color:#e8e6dc}button{background:#d29a7e;color:#141413;border-color:#d29a7e;cursor:pointer}p{margin:0;color:#e57f77;font-size:13px}</style>
<form method="post" action="${escape(project)}_unlock"><label for="p">This page is private. Enter its password.</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus required>${wrong ? '<p role="alert">That password is not right.</p>' : ''}<button>Open</button></form>`, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } }));
const privatePage = () => html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private page</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1f1e1d;color:#f0eee6;font:15px system-ui,sans-serif;text-align:center;padding:16px}</style><p>This page is private. Ask the person who sent it to share it with you.</p>`, 403);

// ---- Koan, and his preview pages ----
async function ownerHash(env, origin) {
  const response = await env.ASSETS.fetch(new Request(new URL('/_owner.json', origin)));
  if (!response.ok) return '';
  try { return String((await response.json()).hash || ''); } catch { return ''; }
}
const bearer = (request) => (/^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(request.headers.get('authorization') || '') || [])[1] || '';
// Tris: the bearer key. Koan's browsers: a session made from a sign-in code. A session counts for changes only when
// they come from the site's own screens (a page's sandboxed frame has no origin).
async function isOwner(request, env, url, write = false) {
  const key = bearer(request);
  if (key) { const hash = await ownerHash(env, url.origin); return !!hash && (await sha256(key)) === hash; }
  const session = readCookie(request, 'owner');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(session) || (write && request.headers.get('origin') !== url.origin)) return false;
  await pagesTable(env);
  const { results } = await env.NOTES.prepare("SELECT token FROM owners WHERE token = ? AND kind = 'session'").bind(await sha256(session)).all();
  return results.length === 1;
}

const PAGES = `CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, folder TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
  entry TEXT NOT NULL, model TEXT, chat_id TEXT, chat_title TEXT, version INTEGER NOT NULL, files INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL, updated INTEGER NOT NULL, access TEXT NOT NULL DEFAULT 'private', salt TEXT, hash TEXT,
  token TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0)`;
// Sign-in codes and Koan's browser sessions, kept as SHA-256 (a copy of the database opens nothing).
const OWNERS = 'CREATE TABLE IF NOT EXISTS owners (token TEXT PRIMARY KEY, kind TEXT NOT NULL, created INTEGER NOT NULL)';
// The Worker makes its own tables, so a site set up before preview pages needs nothing new from Tris.
const tables = new WeakMap();
function pagesTable(env) {
  let ready = tables.get(env.NOTES);
  if (!ready) {
    ready = env.NOTES.prepare(PAGES).bind().run().then(() => env.NOTES.prepare(OWNERS).bind().run());
    tables.set(env.NOTES, ready); ready.catch(() => tables.delete(env.NOTES));
  }
  return ready;
}
const CODE_LIFE = 120000;
// Tris asks for a code each time it opens a page for Koan.
async function signInCode(request, env, url) {
  if (request.method !== 'POST' || !bearer(request) || !(await isOwner(request, env, url))) return json({ error: 'Only the owner can do that.' }, 401);
  await pagesTable(env);
  const code = randomId(), now = Date.now();
  await env.NOTES.prepare("DELETE FROM owners WHERE kind = 'code' AND created < ?").bind(now - CODE_LIFE).run();
  await env.NOTES.prepare("INSERT INTO owners (token, kind, created) VALUES (?, 'code', ?)").bind(await sha256(code), now).run();
  return json({ code, expires: now + CODE_LIFE });
}
// A code works once, for two minutes; the browser gets its own session and the address loses the code.
async function signIn(env, url) {
  const code = url.searchParams.get('login') || '';
  url.searchParams.delete('login');
  let cookie = null;
  if (/^[A-Za-z0-9_-]{16,64}$/.test(code)) {
    await pagesTable(env);
    const hash = await sha256(code), { results } = await env.NOTES.prepare("SELECT created FROM owners WHERE token = ? AND kind = 'code'").bind(hash).all();
    await env.NOTES.prepare("DELETE FROM owners WHERE token = ? AND kind = 'code'").bind(hash).run();
    if (results.length === 1 && results[0].created > Date.now() - CODE_LIFE) {
      const session = randomId();
      await env.NOTES.prepare("INSERT INTO owners (token, kind, created) VALUES (?, 'session', ?)").bind(await sha256(session), Date.now()).run();
      cookie = unlockCookie('owner', session);
    }
  }
  return privately(new Response(null, { status: 303, headers: { location: url.pathname + url.search, ...(cookie ? { 'set-cookie': cookie } : {}) } }));
}
async function pageRow(env, id, withDeleted = false) {
  await pagesTable(env);
  const { results } = await env.NOTES.prepare('SELECT * FROM pages WHERE id = ?' + (withDeleted ? '' : ' AND deleted = 0')).bind(id).all();
  return results[0] || null;
}
async function canView(request, env, url, page) {
  if (page.access === 'link') return true;
  if (page.access === 'password' && page.hash && readCookie(request, 'page_' + page.id) === page.hash) return true;
  return isOwner(request, env, url);
}
// What Tris and the screens see of a page: never its password hash or its token.
const view = (p) => ({ id: p.id, title: p.title, description: p.description, entry: p.entry, model: p.model, chatId: p.chat_id, chatTitle: p.chat_title,
  version: p.version, files: p.files, created: p.created, updated: p.updated, access: p.access, pinned: !!p.pinned });

// Cloudflare answers /x/index.html and /x/page.html with a redirect to /x/ and /x/page; the Worker follows it once.
async function asset(env, origin, path) {
  const response = await env.ASSETS.fetch(new Request(new URL(path, origin)));
  const to = response.status >= 300 && response.status < 400 && response.headers.get('location');
  return to ? env.ASSETS.fetch(new Request(new URL(to, origin))) : response;
}
const layer = (attributes) => `<script src="/_notes/notes.js" ${attributes} defer></script>`;
const withLayer = (response, attributes) => new HTMLRewriter().on('body', { element(el) { el.append(layer(attributes), { html: true }); } }).transform(response);

async function pagesApi(request, env, url) {
  const [id = '', action = ''] = url.pathname.slice('/api/pages'.length).split('/').filter(Boolean);
  if (!(await isOwner(request, env, url, request.method !== 'GET'))) return json({ error: 'Only the owner can do that.' }, 401);
  await pagesTable(env);
  if (!id) {
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);
    // Tris also reads deleted pages and each page's folder, to copy duplicates and clear deleted files.
    const all = url.searchParams.get('all') === '1' && !!bearer(request);
    const { results } = await env.NOTES.prepare('SELECT * FROM pages' + (all ? '' : ' WHERE deleted = 0') + ' ORDER BY pinned DESC, updated DESC').bind().all();
    return json(results.map((p) => (all ? { ...view(p), folder: p.folder, deleted: !!p.deleted } : view(p))));
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return json({ error: 'No such page.' }, 404);
  const body = ['PUT', 'PATCH'].includes(request.method) ? await request.json().catch(() => null) : null;
  if (['PUT', 'PATCH'].includes(request.method) && (!body || typeof body !== 'object')) return json({ error: 'Send JSON.' }, 400);
  // Publishing: only Tris, which has just deployed the page's files to the folder named here.
  if (request.method === 'PUT') {
    if (!bearer(request)) return json({ error: 'Only Tris publishes pages.' }, 403);
    const text = (v, n) => (v == null ? null : String(v).slice(0, n));
    const title = String(body.title || '').trim().slice(0, 200), entry = String(body.entry || ''), version = Number(body.version), files = Number(body.files) || 1;
    const folder = String(body.folder || id);
    if (!title || !/^[^/\\]+\.html?$/i.test(entry) || !Number.isInteger(version) || version < 1 || !/^[A-Za-z0-9_-]{16,64}$/.test(folder)) return json({ error: 'A page needs a title, an HTML entry file, a folder and a version.' }, 400);
    const existing = await pageRow(env, id, true), now = Date.now();
    if (existing) {
      await env.NOTES.prepare('UPDATE pages SET folder = ?, title = ?, description = ?, entry = ?, model = ?, chat_id = ?, chat_title = ?, version = ?, files = ?, updated = ?, deleted = 0 WHERE id = ?')
        .bind(folder, title, text(body.description, 600), entry, text(body.model, 80), text(body.chatId, 80), text(body.chatTitle, 200), version, files, now, id).run();
    } else {
      await env.NOTES.prepare('INSERT INTO pages (id, folder, title, description, entry, model, chat_id, chat_title, version, files, created, updated, access, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, folder, title, text(body.description, 600), entry, text(body.model, 80), text(body.chatId, 80), text(body.chatTitle, 200), version, files, now, now, 'private', randomId()).run();
    }
    return json(view(await pageRow(env, id)), existing ? 200 : 201);
  }
  const page = await pageRow(env, id);
  if (!page) return json({ error: 'No such page.' }, 404);
  // A duplicate shows its source's files until Tris copies them (before its next deploy, so they never change).
  if (request.method === 'POST' && action === 'duplicate') {
    const copy = randomId(), now = Date.now();
    await env.NOTES.prepare('INSERT INTO pages (id, folder, title, description, entry, model, chat_id, chat_title, version, files, created, updated, access, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(copy, page.folder, (page.title + ' (copy)').slice(0, 200), page.description, page.entry, page.model, page.chat_id, page.chat_title, 1, page.files, now, now, 'private', randomId()).run();
    return json(view(await pageRow(env, copy)), 201);
  }
  // Deleting ends the link at once; Tris removes the files at its next deploy.
  if (request.method === 'DELETE') {
    await env.NOTES.prepare('UPDATE pages SET deleted = 1, token = ? WHERE id = ?').bind(randomId(), id).run();
    return json({ deleted: true });
  }
  if (request.method !== 'PATCH') return json({ error: 'Use PUT, PATCH, POST or DELETE.' }, 405);
  const set = {};
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title || title.length > 200) return json({ error: 'Give it a title of up to 200 characters.' }, 400);
    set.title = title;
  }
  if (body.pinned !== undefined) set.pinned = body.pinned ? 1 : 0;
  if (body.access !== undefined) {
    if (!['private', 'link', 'password'].includes(body.access)) return json({ error: 'Choose private, link or password.' }, 400);
    set.access = body.access;
    if (body.access === 'password') {
      const password = typeof body.password === 'string' ? body.password : '';
      if (password) {
        if (password.length < 4 || password.length > 200) return json({ error: 'Choose a password of 4 to 200 characters.' }, 400);
        set.salt = hex(crypto.getRandomValues(new Uint8Array(16)));
        set.hash = await derive(password, set.salt);
      } else if (!(page.access === 'password' && page.hash)) return json({ error: 'Choose a password of at least 4 characters.' }, 400);
    } else { set.salt = null; set.hash = null; }
    // A new token closes frames opened under the old setting.
    set.token = randomId();
  }
  const keys = Object.keys(set);
  if (!keys.length) return json({ error: 'Nothing to change.' }, 400);
  await env.NOTES.prepare('UPDATE pages SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?').bind(...keys.map((k) => set[k]), id).run();
  return json(view(await pageRow(env, id)));
}

async function previewPage(request, env, url, page) {
  const base = '/' + page.id + '/', rest = url.pathname.slice(base.length);
  // The page's own files, in its sandboxed frame: the token in the address is the access (frames carry no origin).
  if (rest.startsWith('v/')) {
    const [token, ...file] = rest.slice(2).split('/');
    if (token !== page.token || !['GET', 'HEAD'].includes(request.method)) return notFound();
    const response = await asset(env, url.origin, '/' + page.folder + '/' + (file.join('/') || page.entry));
    if (!response.ok) return notFound();
    const out = privately((response.headers.get('content-type') || '').includes('text/html')
      ? withLayer(response, `data-frame="1" data-page="${base}" data-version="${page.version}"`) : response);
    out.headers.set('Content-Security-Policy', 'sandbox ' + SANDBOX);
    out.headers.set('Cache-Control', 'no-store');
    return out;
  }
  if (request.method === 'POST' && rest === '_unlock') {
    const form = await request.formData().catch(() => null), password = String(form?.get('password') || '');
    if (page.access !== 'password' || !page.hash || !password || (await derive(password, page.salt)) !== page.hash) return lockPage(base, true);
    return privately(new Response(null, { status: 303, headers: { location: base, 'set-cookie': unlockCookie('page_' + page.id, page.hash) } }));
  }
  if (!(await canView(request, env, url, page))) return page.access === 'password' ? lockPage(base, false) : privatePage();
  if (rest === '') return html(viewer(page, { owner: await isOwner(request, env, url), origin: url.origin }));
  if (rest === 'manifest.webmanifest') return privately(new Response(JSON.stringify(manifest(page)), { headers: { 'content-type': 'application/manifest+json' } }));
  if (rest === 'markdown' || rest === 'export') {
    const zip = rest === 'export' && page.files > 1 && (await asset(env, url.origin, '/' + page.folder + '/_export.zip'));
    if (zip && zip.ok) return privately(new Response(zip.body, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${slug(page.title)}.zip"` } }));
    const entry = await asset(env, url.origin, '/' + page.folder + '/' + page.entry);
    if (!entry.ok) return notFound();
    if (rest === 'markdown') return privately(new Response(markdownOf(await entry.text()), { headers: { 'content-type': 'text/markdown; charset=utf-8' } }));
    return privately(new Response(entry.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="${slug(page.title)}.html"` } }));
  }
  return notFound();
}

export async function notes(request, env, url) {
  if (request.method === 'GET') {
    const page = url.searchParams.get('page'), project = url.searchParams.get('project');
    const since = Number(url.searchParams.get('since') || 0) || 0;
    // Tris's feed of notes on Koan's preview pages.
    if (!page && !project && url.searchParams.get('pages') === '1') {
      if (!bearer(request) || !(await isOwner(request, env, url))) return json({ error: 'Only the owner can do that.' }, 401);
      await pagesTable(env);
      const { results } = await env.NOTES.prepare("SELECT notes.* FROM notes JOIN pages ON notes.page = '/' || pages.id || '/' WHERE notes.created > ? ORDER BY notes.created").bind(since).all();
      return json(results);
    }
    const owner = page && ID.test(page) && page.length <= 300 ? projectOf(page) : project && PROJECT.test(project) ? project : '';
    if (!owner) return json({ error: 'Name a shared page or project.' }, 400);
    const preview = await pageRow(env, owner.slice(1, -1), true);
    if (preview?.deleted) return json({ error: 'No such page.' }, 404);
    if (preview ? !(await canView(request, env, url, preview)) : !allowed(request, url, await shareOf(env, url.origin, owner), owner)) return json({ error: 'This page is private.' }, 401);
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
  let version;
  const preview = await pageRow(env, projectOf(page).slice(1, -1), true);
  if (preview?.deleted) return json({ error: 'This page cannot take notes.' }, 404);
  if (preview) {
    // A preview page takes notes on the page as a whole (its files have no addresses of their own).
    if (page !== '/' + preview.id + '/') return json({ error: 'This page cannot take notes.' }, 400);
    if (!(await canView(request, env, url, preview))) return json({ error: 'This page is private.' }, 401);
    version = preview.version;
  } else {
    const share = await shareOf(env, url.origin, projectOf(page));
    if (!allowed(request, url, share, projectOf(page))) return json({ error: 'This page is private.' }, 401);
    const asset = await env.ASSETS.fetch(new Request(new URL(page, url.origin)));
    if (!asset.ok) return json({ error: 'This page cannot take notes.' }, 404);
    version = share.version;
  }
  const num = (v) => (v != null && v !== '' && Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : null);
  const note = {
    id: crypto.randomUUID(), page, anchor: String(n.anchor || '').slice(0, 600) || null,
    fx: num(n.fx), fy: num(n.fy), px: num(n.px), py: num(n.py), text, name, created: Date.now(),
    version: Number.isInteger(version) ? version : null,
  };
  await env.NOTES.prepare('INSERT INTO notes (id, page, anchor, fx, fy, px, py, text, name, created, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(note.id, note.page, note.anchor, note.fx, note.fy, note.px, note.py, note.text, note.name, note.created, note.version).run();
  return json(note, 201);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/notes') return notes(request, env, url);
    if (url.pathname === '/api/pages' || url.pathname.startsWith('/api/pages/')) return pagesApi(request, env, url);
    if (url.pathname === '/api/login') return signInCode(request, env, url);
    if (url.pathname.startsWith('/_notes/')) return privately(await env.ASSETS.fetch(request));
    if (url.searchParams.has('login')) return signIn(env, url);
    if (url.pathname === '/pages' || url.pathname === '/pages/') {
      if (!(await isOwner(request, env, url))) return notFound();
      await pagesTable(env);
      const { results } = await env.NOTES.prepare('SELECT * FROM pages WHERE deleted = 0 ORDER BY pinned DESC, updated DESC').bind().all();
      return html(home(results));
    }
    // Nothing lists the shared folders, and a project's settings file is never served.
    const project = projectOf(url.pathname);
    if (!project || url.pathname.endsWith('/_share.json')) return notFound();
    // A deleted page's files stay until Tris's next deploy; they are never served as anything else.
    const preview = await pageRow(env, project.slice(1, -1), true);
    if (preview) return preview.deleted ? notFound() : previewPage(request, env, url, preview);
    const share = await shareOf(env, url.origin, project);
    if (request.method === 'POST' && url.pathname === project + '_unlock') {
      const form = await request.formData().catch(() => null), password = String(form?.get('password') || '');
      if (!share.password || !password || (await derive(password, share.password.salt)) !== share.password.hash) return lockPage(project, true);
      return privately(new Response(null, { status: 303, headers: { location: project, 'set-cookie': unlockCookie(cookieName(project), share.password.hash) } }));
    }
    if (!allowed(request, url, share, project)) return lockPage(project, false);
    // The "for your AI" address: plain text Koan approved (3.7).
    if (url.pathname === project + 'for-ai') {
      const text = await env.ASSETS.fetch(new Request(new URL(project + 'for-ai.txt', url.origin)));
      if (!text.ok) return notFound();
      return privately(new Response(text.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    }
    const response = await env.ASSETS.fetch(request);
    if (!(response.headers.get('content-type') || '').includes('text/html')) return privately(response);
    // The notes layer goes on every shared page without touching the page's own files.
    return privately(withLayer(response, `data-version="${Number.isInteger(share.version) ? share.version : 0}"`));
  },
};
