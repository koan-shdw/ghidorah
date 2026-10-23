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
console.log('PASS share site: notes, versions, settings file hidden, passwords, AI address and key');
