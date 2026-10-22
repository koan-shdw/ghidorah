// node share/test.mjs: the notes rules against a stand-in D1 and asset store (no Cloudflare needed).
import assert from 'node:assert/strict';
import { notes, pageKey } from './src/worker.js';

const rows = [];
const env = {
  ASSETS: { fetch: async (req) => new Response('', { status: new URL(req.url).pathname.startsWith('/B9c4757rgb9ELNNxQBJktw/') ? 200 : 404 }) },
  NOTES: { prepare: (sql) => ({ bind: (...a) => ({
    run: async () => rows.push({ id: a[0], page: a[1], text: a[7], name: a[8], created: a[9] }),
    all: async () => ({ results: sql.includes('page = ?') ? rows.filter((r) => r.page === a[0]) : rows.filter((r) => r.page >= a[0] && r.page < a[1] && r.created > a[2]) }),
  }) }) },
};
const call = (method, query = '', body) => {
  const url = new URL('https://share.test/api/notes' + query);
  return notes(new Request(url, { method, body: body && JSON.stringify(body) }), env, url);
};
const page = '/B9c4757rgb9ELNNxQBJktw/';

assert.equal(pageKey('/abc/index.html'), '/abc/');
assert.equal((await call('POST', '', { page, text: 'Bigger logo', name: 'Ana', fx: 2 })).status, 201);
assert.equal((await call('POST', '', { page: page + 'index.html', text: 'Same page', name: 'Ana' })).status, 201);
assert.equal((await call('POST', '', { page, text: '', name: 'Ana' })).status, 400, 'empty note');
assert.equal((await call('POST', '', { page, text: 'x', name: '' })).status, 400, 'no name');
assert.equal((await call('POST', '', { page: '/short/', text: 'x', name: 'Ana' })).status, 400, 'not a shared folder');
assert.equal((await call('POST', '', { page: '/AAAAAAAAAAAAAAAAAAAA/', text: 'x', name: 'Ana' })).status, 404, 'no such page');
const onPage = await (await call('GET', '?page=' + encodeURIComponent(page))).json();
assert.equal(onPage.length, 2);
const project = await (await call('GET', '?project=' + encodeURIComponent(page) + '&since=0')).json();
assert.equal(project.length, 2);
assert.equal((await call('GET', '?project=%2F')).status, 400, 'the whole store is never listed');
console.log('PASS share notes rules');
