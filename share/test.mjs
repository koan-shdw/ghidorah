// node share/test.mjs: the share site's rules against SQLite (the SQL D1 runs) and an in-memory asset store
// (no Cloudflare needed): notes, versions (3.5), passwords (3.2) and the "for your AI" address with its key (3.7).
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// The one thing the Worker asks of HTMLRewriter: add the notes layer at the end of the body.
globalThis.HTMLRewriter ??= class {
  on(_selector, handler) { this.handler = handler; return this; }
  transform(response) {
    const handler = this.handler;
    return new Response(new ReadableStream({ async start(controller) {
      const html = await response.text(); let added = '';
      handler.element({ append: (text) => { added += text; } });
      controller.enqueue(new TextEncoder().encode(html.replace(/<\/body>/i, added + '</body>'))); controller.close();
    } }), { status: response.status, headers: response.headers });
  }
};
const worker = await import('./src/worker.js');
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const open = '/B9c4757rgb9ELNNxQBJktw/', locked = '/LockedProject0000000001/';
const salt = 'fixture-salt', hash = pbkdf2Sync('open sesame', salt, 100000, 32, 'sha256').toString('hex');
const files = {
  [open + 'index.html']: '<html><body><h1>Home</h1></body></html>',
  [open + '_share.json']: JSON.stringify({ version: 2, aiKey: 'openkey' }),
  [open + 'for-ai.txt']: 'WHAT THIS PROJECT IS\nA test.',
  [locked + 'index.html']: '<html><body><h2>Pricing</h2></body></html>',
  [locked + '_share.json']: JSON.stringify({ version: 1, aiKey: 'secretkey', password: { salt, hash } }),
  [locked + 'for-ai.txt']: 'WHAT THIS PROJECT IS\nA locked test.',
};
const env = {
  ASSETS: { fetch: async (request) => {
    const path = new URL(request.url).pathname.replace(/\/$/, '/index.html'), body = files[path];
    return body == null ? new Response('Not found', { status: 404 }) : new Response(body, { headers: { 'content-type': path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.json') ? 'application/json' : 'text/plain' } });
  } },
  NOTES: { prepare: (sql) => ({ bind: (...values) => ({ all: async () => ({ results: db.prepare(sql).all(...values) }), run: async () => db.prepare(sql).run(...values) }) }) },
};
const fetch = (path, init = {}) => worker.default.fetch(new Request('https://share.test' + path, init), env);
const post = (body, query = '', headers = {}) => fetch('/api/notes' + query, { method: 'POST', body: JSON.stringify(body), headers });

// Notes, as before.
assert.equal(worker.pageKey('/abc/index.html'), '/abc/');
assert.equal((await post({ page: open, text: 'Bigger logo', name: 'Ana', fx: 2 })).status, 201);
assert.equal((await post({ page: open + 'index.html', text: 'Same page', name: 'Ana' })).status, 201);
assert.equal((await post({ page: open, text: '', name: 'Ana' })).status, 400, 'empty note');
assert.equal((await post({ page: open, text: 'x', name: '' })).status, 400, 'no name');
assert.equal((await post({ page: '/short/', text: 'x', name: 'Ana' })).status, 400, 'not a shared folder');
assert.equal((await post({ page: '/AAAAAAAAAAAAAAAAAAAA/', text: 'x', name: 'Ana' })).status, 404, 'no such page');
const onPage = await (await fetch('/api/notes?page=' + encodeURIComponent(open))).json();
assert.equal(onPage.length, 2);
assert.equal(onPage[0].version, 2, 'a note records the version it was written on (3.5)');
assert.equal(onPage[0].fx, 1, 'spots are clamped');
assert.equal(onPage[1].fx, null, 'a missing spot stays empty');
assert.equal((await (await fetch('/api/notes?project=' + encodeURIComponent(open) + '&since=0')).json()).length, 2);
assert.equal((await fetch('/api/notes?project=%2F')).status, 400, 'the whole store is never listed');

// Pages: the layer carries the version; the settings file is never served; nothing is listed.
const page = await fetch(open);
assert.equal(page.status, 200);
assert.match(await page.text(), /<script src="\/_notes\/notes\.js" data-version="2" defer><\/script><\/body>/);
assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
assert.equal((await fetch(open + '_share.json')).status, 404, 'the settings file (password hash, AI key) is never served');
assert.equal((await fetch('/')).status, 404);
const ai = await fetch(open + 'for-ai');
assert.equal(ai.status, 200); assert.match(ai.headers.get('content-type'), /^text\/plain/); assert.match(await ai.text(), /A test/);

// A password (3.2): the page, its notes and its AI address all need it, or the AI key (3.7).
const gate = await fetch(locked);
assert.equal(gate.status, 401); assert.match(await gate.text(), /This page is private/);
assert.equal((await fetch(locked + 'for-ai')).status, 401);
assert.equal((await fetch('/api/notes?project=' + encodeURIComponent(locked))).status, 401);
assert.equal((await post({ page: locked, text: 'x', name: 'Ana' })).status, 401);
const unlock = (password) => fetch(locked + '_unlock', { method: 'POST', body: new URLSearchParams({ password }) });
assert.equal((await unlock('wrong')).status, 401, 'a wrong password shows the form again');
const right = await unlock('open sesame');
assert.equal(right.status, 303); assert.equal(right.headers.get('location'), locked);
const cookie = right.headers.get('set-cookie').split(';')[0];
assert.match(right.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
assert.equal((await fetch(locked, { headers: { cookie } })).status, 200);
assert.equal((await post({ page: locked, text: 'Price is wrong', name: 'Ben' }, '', { cookie })).status, 201);
assert.equal((await fetch(locked + 'for-ai?key=secretkey')).status, 200, 'the AI address carries its own key');
assert.equal((await fetch(locked + 'for-ai?key=nope')).status, 401);
const lockedNotes = await (await fetch('/api/notes?project=' + encodeURIComponent(locked) + '&key=secretkey')).json();
assert.equal(lockedNotes.length, 1); assert.equal(lockedNotes[0].version, 1);
assert.equal((await fetch(locked, { headers: { cookie: 'share_LockedProject0000000001=' + 'f'.repeat(64) } })).status, 401, 'a made-up cookie does not open it');
assert.equal(await worker.derive('open sesame', salt), hash, 'the Worker derives exactly what Tris stores');
// Koan's preview pages (FEATURE-SPECS 4): private until shared; the owner key as a bearer token (Tris) or a cookie.
const { createHash } = await import('node:crypto');
const ownerKey = 'OwnerKey0000000000000001', mock = 'MockupPage000000000001', bearer = { authorization: 'Bearer ' + ownerKey };
files['/_owner.json'] = JSON.stringify({ hash: createHash('sha256').update(ownerKey).digest('hex') });
files['/' + mock + '/index.html'] = '<html><title>x</title><body><h1>Video &amp; Editor</h1><ul><li>One</li><li>Two</li></ul><script>1</script><img src="a.png"></body></html>';
files['/' + mock + '/a.png'] = 'png';
const pages = (path = '', init = {}) => fetch('/api/pages' + path, init);
const put = (body, headers = bearer) => pages('/' + mock, { method: 'PUT', headers, body: JSON.stringify(body) });
assert.equal((await pages()).status, 401, 'nobody else lists the pages');
assert.equal((await fetch('/_owner.json')).status, 404, 'the owner file is never served');
assert.equal((await put({ title: 'Video Editor', entry: 'index.html', version: 1 }, { authorization: 'Bearer NotTheOwnerKey00000001' })).status, 401);
const made = await put({ title: 'Video Editor', description: 'Both editors in one frame', entry: 'index.html', version: 1, files: 2, model: 'Opus 5.5', chatId: 'chat-1', chatTitle: 'Video editor redesign' });
assert.equal(made.status, 201); const madeRow = await made.json();
assert.equal(madeRow.access, 'private', 'a new page is private'); assert.equal(madeRow.token, undefined, 'the token never leaves the site');
assert.equal((await fetch('/' + mock + '/')).status, 403, 'a private page does not open for anyone else');
assert.equal((await fetch('/' + mock + '/markdown')).status, 403);
assert.equal((await fetch('/api/notes?page=' + encodeURIComponent('/' + mock + '/'))).status, 401);
assert.equal((await post({ page: '/' + mock + '/', text: 'x', name: 'Ana' })).status, 401);
// Tris asks for a one-time sign-in code to open a page as Koan; the owner key never goes in an address.
assert.equal((await fetch('/api/login', { method: 'POST' })).status, 401, 'only Tris gets codes');
assert.equal((await fetch('/api/login', { method: 'POST', headers: { authorization: 'Bearer NotTheOwnerKey00000001' } })).status, 401);
const code = async () => (await (await fetch('/api/login', { method: 'POST', headers: bearer })).json()).code;
const wrongCode = await fetch('/' + mock + '/?login=WrongCode000000000000001');
assert.equal(wrongCode.status, 303); assert.equal(wrongCode.headers.get('set-cookie'), null);
const firstCode = await code(), opened = await fetch('/' + mock + '/?login=' + firstCode + '&x=1');
assert.equal(opened.status, 303); assert.equal(opened.headers.get('location'), '/' + mock + '/?x=1', 'the code leaves the address');
assert.match(opened.headers.get('set-cookie'), /^owner=[A-Za-z0-9_-]{22}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
const me = { cookie: opened.headers.get('set-cookie').split(';')[0] }, mine = { ...me, origin: 'https://share.test' };
assert.notEqual(me.cookie, 'owner=' + firstCode, 'the session is not the code');
assert.equal((await fetch('/' + mock + '/?login=' + firstCode)).headers.get('set-cookie'), null, 'a code works once');
const staleCode = await code(); db.prepare("UPDATE owners SET created = created - 200000 WHERE kind = 'code'").run();
assert.equal((await fetch('/' + mock + '/?login=' + staleCode)).headers.get('set-cookie'), null, 'and for two minutes');
assert.equal((await fetch('/' + mock + '/', { headers: { cookie: 'owner=' + ownerKey } })).status, 403, 'the key itself is no session');
assert.ok(!db.prepare('SELECT token FROM owners').all().some((row) => row.token === me.cookie.slice(6)), 'sessions are kept as hashes');
const viewerHtml = await (await fetch('/' + mock + '/', { headers: me })).text();
const token = /src="\/MockupPage000000000001\/v\/([A-Za-z0-9_-]+)\/" sandbox="allow-scripts allow-forms/.exec(viewerHtml)?.[1];
assert.ok(token, 'the viewer frames the page, sandboxed, at its token');
assert.doesNotMatch(viewerHtml, /allow-same-origin/, 'the page never gets the site as its origin');
for (const part of ['Video Editor', 'href="/pages"', 'trismegistus://chat/chat-1', 'data-action="rename"', 'data-action="delete"', 'class="outline share"', 'manifest.webmanifest']) assert.ok(viewerHtml.includes(part), part);
const framed = await fetch('/' + mock + '/v/' + token + '/');
assert.equal(framed.status, 200, 'the frame needs no cookie, only the token');
assert.match(framed.headers.get('content-security-policy'), /^sandbox allow-scripts/);
assert.match(await framed.text(), /<script src="\/_notes\/notes\.js" data-frame="1" data-page="\/MockupPage000000000001\/" data-version="1" defer><\/script><\/body>/);
assert.equal(await (await fetch('/' + mock + '/v/' + token + '/a.png')).text(), 'png', 'the page’s own files');
assert.equal((await fetch('/' + mock + '/v/WrongToken00000000000001/')).status, 404);
assert.equal((await fetch('/' + mock + '/a.png', { headers: me })).status, 404, 'files only through the frame');
assert.equal(await (await fetch('/' + mock + '/markdown', { headers: me })).text(), '# Video & Editor\n\n- One\n- Two\n');
const exported = await fetch('/' + mock + '/export', { headers: me });
assert.equal(exported.headers.get('content-disposition'), 'attachment; filename="video-editor.html"', 'no zip was published, so the page itself');
assert.equal((await (await fetch('/' + mock + '/manifest.webmanifest', { headers: me })).json()).start_url, '/' + mock + '/');
// Changes from the web need the owner and the site's own origin (a sandboxed page sends "null").
assert.equal((await pages('/' + mock, { method: 'PATCH', headers: me, body: JSON.stringify({ title: 'X' }) })).status, 401, 'no origin, no change');
assert.equal((await pages('/' + mock, { method: 'PATCH', headers: { ...me, origin: 'null' }, body: JSON.stringify({ title: 'X' }) })).status, 401);
assert.equal((await put({ title: 'X', entry: 'index.html', version: 9 }, mine)).status, 403, 'only Tris publishes');
const renamed = await pages('/' + mock, { method: 'PATCH', headers: mine, body: JSON.stringify({ title: 'Video Editor Redesign', pinned: true }) });
assert.equal(renamed.status, 200); assert.equal((await renamed.json()).title, 'Video Editor Redesign');
// Share: anyone with the link; a new token closes frames opened before.
const shared = await (await pages('/' + mock, { method: 'PATCH', headers: mine, body: JSON.stringify({ access: 'link' }) })).json();
assert.equal(shared.access, 'link');
assert.equal((await fetch('/' + mock + '/v/' + token + '/')).status, 404, 'the old frame address closes');
const guest = await (await fetch('/' + mock + '/')).text();
assert.ok(guest.includes('Video Editor Redesign'));
for (const part of ['href="/pages"', 'trismegistus://', 'data-action="rename"', 'data-action="delete"', 'class="outline share"']) assert.ok(!guest.includes(part), 'a guest has no ' + part);
const note = await post({ page: '/' + mock + '/', text: 'Header: bigger', name: 'Ana', fx: 0.5, fy: 0.5 });
assert.equal(note.status, 201); assert.equal((await note.json()).version, 1);
assert.equal((await post({ page: '/' + mock + '/a.png', text: 'x', name: 'Ana' })).status, 400, 'notes are on the page as a whole');
assert.equal((await fetch('/api/notes?pages=1&since=0')).status, 401, 'the feed is Tris’s');
const feed = await (await fetch('/api/notes?pages=1&since=0', { headers: bearer })).json();
assert.deepEqual(feed.map((n) => n.text), ['Header: bigger'], 'only notes on preview pages');
// A password.
assert.equal((await pages('/' + mock, { method: 'PATCH', headers: mine, body: JSON.stringify({ access: 'password' }) })).status, 400, 'a password is needed');
assert.equal((await pages('/' + mock, { method: 'PATCH', headers: mine, body: JSON.stringify({ access: 'password', password: 'pw12' }) })).status, 200);
assert.equal((await fetch('/' + mock + '/')).status, 401);
const pageUnlock = await fetch('/' + mock + '/_unlock', { method: 'POST', body: new URLSearchParams({ password: 'pw12' }) });
assert.equal(pageUnlock.status, 303);
assert.equal((await fetch('/' + mock + '/', { headers: { cookie: pageUnlock.headers.get('set-cookie').split(';')[0] } })).status, 200);
assert.equal((await fetch('/' + mock + '/', { headers: me })).status, 200, 'Koan never needs the password');
// Duplicate, All pages, the list Tris reads, delete.
const copy = await (await pages('/' + mock + '/duplicate', { method: 'POST', headers: mine })).json();
assert.equal(copy.title, 'Video Editor Redesign (copy)'); assert.equal(copy.access, 'private');
const copyToken = /\/v\/([A-Za-z0-9_-]+)\//.exec(await (await fetch('/' + copy.id + '/', { headers: me })).text())[1];
assert.equal(await (await fetch('/' + copy.id + '/v/' + copyToken + '/a.png')).text(), 'png', 'a duplicate shows its source’s files until Tris copies them');
assert.deepEqual((await (await pages('', { headers: me })).json()).map((p) => p.title), ['Video Editor Redesign', 'Video Editor Redesign (copy)'], 'pinned first');
const listed = await (await pages('?all=1', { headers: bearer })).json();
assert.equal(listed.find((p) => p.id === copy.id).folder, mock);
assert.equal((await fetch('/pages')).status, 404, 'All pages is Koan’s');
assert.match(await (await fetch('/pages', { headers: me })).text(), /Video Editor Redesign \(copy\)/);
assert.equal((await pages('/' + mock, { method: 'DELETE', headers: me })).status, 401, 'no origin, no delete');
assert.equal((await pages('/' + mock, { method: 'DELETE', headers: mine })).status, 200);
assert.equal((await fetch('/' + mock + '/', { headers: me })).status, 404, 'a deleted page is gone at once');
assert.equal((await post({ page: '/' + mock + '/', text: 'x', name: 'Ana' })).status, 404);
assert.equal((await (await pages('?all=1', { headers: bearer })).json()).find((p) => p.id === mock).deleted, true, 'Tris sees it, to remove the files');
const again = await put({ title: 'Video Editor', entry: 'index.html', version: 2 });
assert.equal(again.status, 200, 'publishing again brings it back'); assert.equal((await again.json()).access, 'password', 'with the sharing Koan chose');
console.log('PASS share site: notes, versions, settings file hidden, passwords, AI address and key; preview pages: private by default, owner key, sandboxed frame, share, password, notes feed, rename, pin, duplicate, delete, export, markdown');
