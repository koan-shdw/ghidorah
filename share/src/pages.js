// The screens of Koan's preview pages (FEATURE-SPECS 4), copied from Claude's artifact viewer: a top bar (All pages,
// the title with its menu, notes, Chat, Share) over the page, which runs in a sandboxed frame; and All pages.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const data = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICONS = {
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z', chevron: 'M7 10l5 5 5-5', notes: 'M4 5h16v11H9l-5 4z', lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  export: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14', markdown: 'M9 9h10v11H9zM5 15V4h10', install: 'M4 5h16v10H4zM9 19h6M12 15v4',
  rename: 'M5 19l1-4L16 5l3 3L9 18zM14 7l3 3', duplicate: 'M9 9h11v11H9zM5 15V4h11', share: 'M12 15V4M8 8l4-4 4 4M5 13v7h14v-7',
  refresh: 'M19 12a7 7 0 1 1-2-4.9M19 4v4h-4', pin: 'M9 4h6l-1 6 4 4H6l4-4zM12 14v6', all: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  delete: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
};
// The page itself runs without the site's origin, so its scripts can never act as Koan (rename, share, delete).
export const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';
export const slug = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';

const STYLE = `:root{--bg:#1f1e1d;--panel:#262624;--raise:#30302e;--line:#3d3d3a;--text:#f0eee6;--dim:#a6a39a;--accent:#d97757;--danger:#ef7a6c;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#faf9f5;--panel:#fff;--raise:#f0eee6;--line:#dedcd1;--text:#1f1e1d;--dim:#6b6a63;--accent:#c96442;--danger:#c4422f;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
button,.btn{font:inherit;color:inherit;background:none;border:1px solid transparent;border-radius:8px;min-height:34px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;text-decoration:none;white-space:nowrap}
button:hover,.btn:hover{background:var(--raise)}
button:focus-visible,.btn:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.outline{border-color:var(--line)}.go{background:var(--accent);border-color:var(--accent);color:#fff}.go:hover{background:var(--accent);filter:brightness(1.08)}
.danger{color:var(--danger)}
dialog{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:14px;padding:20px;width:min(440px,calc(100vw - 32px));box-shadow:0 20px 60px #0007}
dialog::backdrop{background:#0008}
dialog h2{margin:0 0 14px;font-size:17px}dialog p{margin:0 0 14px;color:var(--dim)}
input[type=text],input[type=password],input[readonly]{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.err{color:var(--danger);font-size:13px;min-height:1em;margin:8px 0 0}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;box-shadow:0 10px 30px #0006;max-width:calc(100vw - 32px);z-index:10}
[hidden]{display:none!important}`;

// One page, as Koan (owner) or someone he shared it with.
export function viewer(page, { owner, origin }) {
  const base = '/' + page.id + '/';
  const info = { id: page.id, base, link: origin + base, title: page.title, model: page.model, chatTitle: page.chat_title, chatId: page.chat_id, updated: page.updated, access: page.access, pinned: !!page.pinned, owner };
  const item = (action, label, cls = '') => `<button role="menuitem" data-action="${action}"${cls ? ` class="${cls}"` : ''}>${icon(ICONS[action])}${label}</button>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.title)}</title><link rel="manifest" href="${base}manifest.webmanifest" crossorigin="use-credentials"><link rel="icon" href="/_notes/icon.png"><meta name="robots" content="noindex">
<style>${STYLE}
body{display:flex;flex-direction:column;overflow:hidden}
header{display:flex;align-items:center;gap:4px;height:52px;padding:0 10px;border-bottom:1px solid var(--line);flex:none;position:relative}
.title{min-width:0;font-weight:500}.title span{overflow:hidden;text-overflow:ellipsis;max-width:min(46vw,520px)}
.grow{flex:1}.count{font-size:12px;color:var(--dim)}
.chat svg{color:var(--accent)}
.menu{position:absolute;top:48px;left:44px;width:min(290px,calc(100vw - 20px));background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:6px;box-shadow:0 16px 48px #0008;z-index:5;display:flex;flex-direction:column}
.menu .who{padding:8px 10px 10px;color:var(--dim);font-size:13px;border-bottom:1px solid var(--line);margin-bottom:4px}.menu .who b{display:block;color:var(--text);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.menu button{width:100%;justify-content:flex-start;gap:10px;min-height:36px}
.menu hr{border:0;border-top:1px solid var(--line);margin:4px 0}
iframe{flex:1;width:100%;border:0;background:#fff}
.access label{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer}
.access label span{grid-column:2;color:var(--dim);font-size:13px}
.access input[type=password]{margin:-2px 0 8px}
.link{display:flex;gap:8px;margin-top:6px}
@media (max-width:560px){.label{display:none}.menu{left:10px}}
</style></head><body>
<header>
${owner ? `<a class="btn" href="/pages" aria-label="All pages" title="All pages">${icon(ICONS.home)}</a>` : ''}
<button class="title" aria-haspopup="menu" aria-expanded="false"><span>${esc(page.title)}</span>${icon(ICONS.chevron)}</button>
<span class="grow"></span>
<button class="notes" aria-label="Notes" title="Notes">${icon(ICONS.notes)}<span class="count">0</span></button>
${owner && page.chat_id ? `<a class="btn outline chat" href="trismegistus://chat/${esc(page.chat_id)}" title="Open the chat that made this page">${icon('M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4')}<span class="label">Chat</span></a>` : ''}
${owner ? `<button class="outline share">${icon(ICONS.lock)}<span class="label">Share</span></button>` : ''}
<div class="menu" role="menu" hidden><div class="who"></div>
${item('export', 'Export')}${item('markdown', 'Copy as Markdown')}${item('install', 'Install page')}
${owner ? `<hr>${item('rename', 'Rename')}${item('duplicate', 'Duplicate')}${item('share', 'Share')}${item('refresh', 'Refresh')}${item('pin', 'Pin')}${item('all', 'All pages')}<hr>${item('delete', 'Delete page', 'danger')}` : item('refresh', 'Refresh')}
</div></header>
<iframe src="${base}v/${esc(page.token)}/" sandbox="${SANDBOX}" allow="clipboard-write; fullscreen" title="${esc(page.title)}"></iframe>
<dialog class="share-dialog" aria-label="Share"><form><h2>Share</h2><div class="access">
<label><input type="radio" name="access" value="private"><b>Private</b><span>Only you can open it.</span></label>
<label><input type="radio" name="access" value="link"><b>Anyone with the link</b><span>No sign-in. People can leave notes.</span></label>
<label><input type="radio" name="access" value="password"><b>Anyone with the link and a password</b><span>They type the password once.</span></label>
<input type="password" name="password" placeholder="Password (at least 4 characters)" autocomplete="new-password" aria-label="Password"></div>
<div class="link"><input readonly aria-label="Link" value="${esc(origin + base)}"><button type="button" class="outline copy">Copy link</button></div>
<p class="err" role="alert"></p><div class="row"><button type="button" class="outline cancel">Cancel</button><button class="go">Save</button></div></form></dialog>
<dialog class="rename-dialog" aria-label="Rename"><form><h2>Rename</h2><input type="text" name="title" maxlength="200" aria-label="Title" required>
<p class="err" role="alert"></p><div class="row"><button type="button" class="outline cancel">Cancel</button><button class="go">Save</button></div></form></dialog>
<dialog class="delete-dialog" aria-label="Delete page"><form><h2>Delete this page?</h2><p></p>
<p class="err" role="alert"></p><div class="row"><button type="button" class="outline cancel">Cancel</button><button class="go" style="background:var(--danger);border-color:var(--danger)">Delete</button></div></form></dialog>
<div class="toast" role="status" hidden></div>
<script>(() => {
const PAGE = ${data(info)}, $ = (s) => document.querySelector(s), frame = $('iframe'), menu = $('.menu'), title = $('.title'), toast = $('.toast');
const say = (text) => { toast.textContent = text; toast.hidden = false; clearTimeout(say.t); say.t = setTimeout(() => { toast.hidden = true; }, 3500); };
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
async function api(method, body, tail = '') {
  const r = await fetch('/api/pages/' + PAGE.id + tail, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const out = await r.json().catch(() => ({})); if (!r.ok) throw Error(out.error || 'That did not work. Try again.'); return out;
}
function who() {
  $('.who').innerHTML = '';
  const by = document.createElement('b'); by.textContent = PAGE.owner ? 'By ' + (PAGE.model || 'a model') + (PAGE.chatTitle ? ' in ' + PAGE.chatTitle : '') : PAGE.title;
  const when = document.createElement('span'); when.textContent = 'Updated ' + ago(PAGE.updated);
  $('.who').append(by, when);
  const pin = menu.querySelector('[data-action=pin]'); if (pin) pin.lastChild.textContent = PAGE.pinned ? 'Unpin' : 'Pin';
}
function showMenu(open) { menu.hidden = !open; title.setAttribute('aria-expanded', String(open)); if (open) { who(); menu.querySelector('button').focus(); } }
title.onclick = () => showMenu(menu.hidden);
addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && !title.contains(e.target)) showMenu(false); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { showMenu(false); title.focus(); } });
let installer = null; addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installer = e; });
function dialog(name, setup, save) {
  const box = $('.' + name + '-dialog'), form = box.querySelector('form'), err = box.querySelector('.err');
  box.querySelector('.cancel').onclick = () => box.close();
  form.onsubmit = async (e) => { e.preventDefault(); err.textContent = ''; const go = form.querySelector('.go'); go.disabled = true; try { await save(form); box.close(); } catch (problem) { err.textContent = problem.message; } go.disabled = false; };
  return () => { err.textContent = ''; setup(form); box.showModal(); };
}
const share = dialog('share', (form) => { form.access.value = PAGE.access; form.password.value = ''; }, async (form) => {
  const next = await api('PATCH', { access: form.access.value, ...(form.password.value ? { password: form.password.value } : {}) });
  PAGE.access = next.access; say(next.access === 'private' ? 'Only you can open it now.' : next.access === 'link' ? 'Anyone with the link can open it.' : 'Anyone with the link and the password can open it.');
});
$('.share-dialog .copy').onclick = () => navigator.clipboard.writeText(PAGE.link).then(() => say('Link copied'), () => say('Copy the link from the box.'));
const rename = dialog('rename', (form) => { form.title.value = PAGE.title; }, async (form) => {
  const next = await api('PATCH', { title: form.title.value }); PAGE.title = next.title; document.title = next.title; title.firstChild.textContent = next.title; frame.title = next.title;
});
const remove = dialog('delete', (form) => { form.querySelector('p').textContent = '“' + PAGE.title + '” will be gone and its link stops working for everyone.'; }, async () => { await api('DELETE'); location.href = '/pages'; });
const actions = {
  export: () => { location.href = PAGE.base + 'export'; },
  markdown: async () => { const r = await fetch(PAGE.base + 'markdown'); if (!r.ok) throw Error('The page could not be read.'); await navigator.clipboard.writeText(await r.text()); say('Copied as Markdown'); },
  install: async () => { if (installer) { installer.prompt(); installer = null; } else say('Use Install in your browser’s menu. In Chrome: ⋮, Cast, save and share, Install page as app.'); },
  rename, share, delete: remove,
  duplicate: async () => { const copy = await api('POST', null, '/duplicate'); location.href = '/' + copy.id + '/'; },
  refresh: () => { frame.src = frame.src; },
  pin: async () => { const next = await api('PATCH', { pinned: !PAGE.pinned }); PAGE.pinned = next.pinned; say(next.pinned ? 'Pinned to the top of All pages' : 'Unpinned'); },
  all: () => { location.href = '/pages'; },
};
menu.addEventListener('click', async (e) => { const b = e.target.closest('[data-action]'); if (!b) return; showMenu(false); try { await actions[b.dataset.action](); } catch (problem) { say(problem.message); } });
const shareButton = $('header .share'); if (shareButton) shareButton.onclick = share;
// Notes: the page's frame has no origin of its own, so the viewer carries its notes to the site, for this page only.
const count = $('.count'), setCount = (n) => { count.textContent = n; };
$('.notes').onclick = () => frame.contentWindow.postMessage({ koan: 'notes-list' }, '*');
fetch('/api/notes?page=' + encodeURIComponent(PAGE.base), { cache: 'no-store' }).then((r) => r.ok ? r.json() : []).then((rows) => setCount(rows.length), () => {});
addEventListener('message', async (e) => {
  if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
  const m = e.data;
  if (m.koan === 'notes-count') { setCount(Number(m.n) || 0); return; }
  if (m.koan !== 'notes') return;
  let reply;
  try {
    const r = m.method === 'POST'
      ? await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(m.body && typeof m.body === 'object' ? m.body : {}), page: PAGE.base }) })
      : await fetch('/api/notes?page=' + encodeURIComponent(PAGE.base), { cache: 'no-store' });
    reply = { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  } catch { reply = { ok: false, status: 0, body: { error: 'The note did not send. Try again.' } }; }
  frame.contentWindow.postMessage({ koan: 'notes-reply', id: m.id, ...reply }, '*');
});
})();</script></body></html>`;
}

// All pages: pinned first, then the newest.
export function home(rows) {
  const card = (p) => `<a class="card" href="/${esc(p.id)}/"><b>${p.pinned ? icon(ICONS.pin) : ''}${esc(p.title)}</b>${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}<span class="meta" data-updated="${Number(p.updated)}">${p.access === 'private' ? 'Private' : p.access === 'link' ? 'Anyone with the link' : 'Password'}</span></a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>All pages</title><link rel="icon" href="/_notes/icon.png"><meta name="robots" content="noindex">
<style>${STYLE}
main{max-width:1080px;margin:0 auto;padding:28px 16px 48px}h1{font-size:22px;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.card{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:inherit;text-decoration:none;min-height:104px}
.card:hover{border-color:var(--dim)}.card b{display:flex;gap:6px;align-items:center;font-weight:500}.card b svg{width:15px;height:15px;color:var(--accent)}
.desc{color:var(--dim);font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{margin-top:auto;color:var(--dim);font-size:12px}.none{color:var(--dim)}
</style></head><body><main><h1>All pages</h1>
${rows.length ? `<div class="grid">${rows.map(card).join('')}</div>` : '<p class="none">No pages yet. Ask a model in Ghidorah to make one.</p>'}
</main><script>for (const m of document.querySelectorAll('[data-updated]')) { const s = (Date.now() - Number(m.dataset.updated)) / 1000; m.textContent = 'Updated ' + (s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago') + ' · ' + m.textContent; }</script></body></html>`;
}

export function manifest(page) {
  const base = '/' + page.id + '/';
  return { name: page.title, short_name: page.title.slice(0, 30), start_url: base, scope: base, display: 'standalone', background_color: '#1f1e1d', theme_color: '#1f1e1d', icons: [{ src: '/_notes/icon.png', sizes: '512x512', type: 'image/png' }] };
}

// "Copy as Markdown": the page's words, headings, lists and links.
const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_m, code) => code[0] === '#' ? String.fromCodePoint(parseInt(code.slice(code[1].toLowerCase() === 'x' ? 2 : 1), code[1].toLowerCase() === 'x' ? 16 : 10)) : { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[code.toLowerCase()]);
export function markdownOf(html) {
  const text = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  let s = String(html).replace(/<(script|style|noscript|template|svg|head|title)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => '\n\n' + '#'.repeat(+n) + ' ' + text(t) + '\n\n');
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => (text(t) ? '[' + text(t) + '](' + href + ')' : ''));
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t) => (text(t) ? '**' + text(t) + '**' : ''));
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t) => (text(t) ? '*' + text(t) + '*' : ''));
  s = s.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|article|header|footer|main|nav|aside|ul|ol|table|tr|blockquote|figure)>/gi, '\n\n');
  return decode(s.replace(/<[^>]+>/g, '')).split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
