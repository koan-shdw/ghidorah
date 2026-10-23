// The notes layer on every shared page (FEATURE-SPECS 3.3): click a spot, type, send; pinned to the spot.
// Name only, no accounts. Everyone with the link sees the page's notes. Lives in a shadow root so it never
// takes or breaks the page's own styles.
(() => {
  if (window.__koanNotes) return;
  window.__koanNotes = true;
  // On a preview page (FEATURE-SPECS 4) the page runs in a sandboxed frame with no origin of its own: the viewer
  // around it names the page and carries its notes to the site.
  const script = document.currentScript, framed = script?.dataset.frame === '1' && parent !== window;
  const page = framed ? script.dataset.page : location.pathname.replace(/\/index\.html?$/i, '/');
  // The version Tris published (3.5) and, on a private page opened from the AI address, its key (3.7).
  const version = Number(script?.dataset.version) || 0;
  const key = new URLSearchParams(location.search).get('key');
  const api = (query = '') => '/api/notes' + query + (key ? (query ? '&' : '?') + 'key=' + encodeURIComponent(key) : '');
  const waiting = new Map();
  let asked = 0;
  // fetch() for the notes API, or the same request through the viewer.
  function request(method, body) {
    if (!framed) return fetch(method === 'POST' ? api() : api('?page=' + encodeURIComponent(page)), method === 'POST' ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }));
    return new Promise((resolve) => { const id = ++asked; waiting.set(id, resolve); parent.postMessage({ koan: 'notes', id, method, body }, '*'); });
  }
  const earlier = (n) => version && n.version != null && n.version < version;
  const store = { get(k) { try { return localStorage.getItem('koan-notes:' + k) || ''; } catch { return ''; } }, set(k, v) { try { localStorage.setItem('koan-notes:' + k, v); } catch {} } };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const when = (t) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  const host = document.createElement('div');
  host.setAttribute('data-koan-notes', '');
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
  :host{all:initial}
  *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .pins{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483600}
  .pin{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50% 50% 50% 4px;background:#d29a7e;color:#141413;border:2px solid #fff;font:600 12px/22px system-ui,sans-serif;text-align:center;cursor:pointer;box-shadow:0 2px 10px #0006;padding:0}
  .pin:focus-visible,button:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid #69ddcf;outline-offset:2px}
  .bubble,.composer{position:absolute;width:min(300px,calc(100vw - 24px));background:#141413;color:#e8e6dc;border:1px solid #30302d;border-radius:10px;padding:12px;box-shadow:0 12px 40px #0008;font-size:13px;line-height:1.5}
  .bubble b{display:block;font-size:12px;color:#d29a7e;margin-bottom:4px}
  .bubble small{display:block;color:#92918a;font-size:11px;margin-top:6px}
  .bubble p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
  textarea,input{width:100%;background:#20201e;color:#e8e6dc;border:1px solid #30302d;border-radius:6px;padding:8px;font-size:14px;margin-bottom:8px}
  textarea{min-height:84px;resize:vertical}
  .row{display:flex;gap:8px;justify-content:flex-end;align-items:center}
  .row span{margin-right:auto;color:#e57f77;font-size:12px}
  button{font:500 13px system-ui,sans-serif;border-radius:999px;border:1px solid #30302d;background:#20201e;color:#e8e6dc;padding:8px 14px;cursor:pointer;min-height:36px}
  button.go{background:#d29a7e;border-color:#d29a7e;color:#141413}
  .bar{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));display:flex;gap:8px;z-index:2147483646}
  .bar button{box-shadow:0 6px 24px #0007;min-height:44px}
  .bar button[aria-pressed=true]{background:#d29a7e;color:#141413;border-color:#d29a7e}
  .shield{position:fixed;inset:0;z-index:2147483645;cursor:crosshair;background:rgba(20,20,19,.06)}
  .hint{position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#141413;color:#e8e6dc;border:1px solid #30302d;border-radius:999px;padding:8px 14px;font-size:13px;z-index:2147483647;pointer-events:none}
  .panel{position:fixed;right:16px;bottom:calc(72px + env(safe-area-inset-bottom,0px));width:min(340px,calc(100vw - 32px));max-height:60vh;overflow:auto;background:#141413;color:#e8e6dc;border:1px solid #30302d;border-radius:12px;z-index:2147483646;box-shadow:0 12px 40px #0008}
  .panel h2{font-size:13px;margin:0;padding:12px 14px;border-bottom:1px solid #30302d}
  .panel ol{list-style:none;margin:0;padding:0}
  .panel li{padding:10px 14px;border-bottom:1px solid #30302d;cursor:pointer;font-size:13px}
  .panel li:hover{background:#20201e}
  .panel li b{color:#d29a7e;margin-right:6px}
  .panel li small{color:#92918a;margin-left:6px;font-size:11px}
  .panel .none{padding:12px 14px;color:#92918a;font-size:13px}
  .pin.old{opacity:.55;background:#92918a}
  .old-tag{color:#92918a;font-size:11px;margin-left:6px}
  .paste{padding:12px 14px;display:grid;gap:8px}
  .paste p{margin:0;color:#92918a;font-size:12px}
  .paste textarea{min-height:120px;margin:0}
  .paste input{margin:0}
  [hidden]{display:none!important}
  @media (prefers-reduced-motion:no-preference){.pin{transition:transform .12s}.pin:hover{transform:scale(1.12)}}
  </style>
  <div class="pins"></div>
  <div class="shield" hidden></div><div class="hint" hidden>Click the spot your note is about · Esc to cancel</div>
  <div class="panel" hidden><h2>Notes on this page</h2><ol></ol></div>
  <form class="panel pastebox" hidden><h2>Paste notes</h2><div class="paste"><p>One note per line, written as Section: note. Notes from an AI work too.</p><textarea aria-label="Notes to paste" placeholder="Header: make the logo bigger"></textarea><input aria-label="Your name" placeholder="Your name" maxlength="60"><div class="row"><span></span><button type="submit" class="go">Send notes</button></div></div></form>
  <div class="bar"><button class="list" type="button">Notes · 0</button><button class="pastebtn" type="button">Paste notes</button><button class="add" type="button" aria-pressed="false">+ Add note</button></div>`;
  const $ = (s) => root.querySelector(s);
  const pins = $('.pins'), shield = $('.shield'), hint = $('.hint'), panel = $('.panel'), list = $('.list'), add = $('.add'), pastebox = $('.pastebox');
  let notes = [], open = null, composer = null;

  // A spot = the element under the click (a short nth-of-type path) and where inside it, so pins stay put when
  // the window is resized. The page-fraction is the fallback when the element is gone in a new version.
  function pathOf(el) {
    const parts = [];
    while (el && el !== document.body && el.nodeType === 1 && parts.length < 14) {
      let i = 1, s = el;
      while ((s = s.previousElementSibling)) if (s.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return 'body' + (parts.length ? '>' + parts.join('>') : '');
  }
  const docSize = () => ({ w: Math.max(document.documentElement.scrollWidth, 1), h: Math.max(document.documentElement.scrollHeight, 1) });
  function spotOf(n) {
    let el = null;
    try { el = n.anchor && document.querySelector(n.anchor); } catch {}
    if (el && n.fx != null) { const r = el.getBoundingClientRect(); if (r.width || r.height) return { x: r.left + scrollX + n.fx * r.width, y: r.top + scrollY + n.fy * r.height }; }
    const d = docSize();
    return { x: (n.px ?? 0.5) * d.w, y: (n.py ?? 0.1) * d.h };
  }
  function draw() {
    pins.querySelectorAll('.pin').forEach((p) => p.remove());
    notes.forEach((n, i) => {
      const b = document.createElement('button'), s = spotOf(n);
      b.className = earlier(n) ? 'pin old' : 'pin'; b.type = 'button'; b.textContent = i + 1; b.style.left = s.x + 'px'; b.style.top = s.y + 'px';
      b.setAttribute('aria-label', 'Note ' + (i + 1) + ' by ' + n.name + (earlier(n) ? ', earlier version' : ''));
      b.onclick = (e) => { e.stopPropagation(); show(i); };
      pins.appendChild(b);
    });
    list.textContent = 'Notes · ' + notes.length;
    if (framed) parent.postMessage({ koan: 'notes-count', n: notes.length }, '*');
    panel.querySelector('ol').innerHTML = notes.length
      ? notes.map((n, i) => `<li data-i="${i}"><b>${i + 1}</b>${esc(n.name)}<small>${esc(when(n.created))}</small>${earlier(n) ? '<span class="old-tag">earlier version</span>' : ''}<br>${esc(n.text.length > 140 ? n.text.slice(0, 140) + '…' : n.text)}</li>`).join('')
      : '<div class="none">No notes yet. Press + Add note, then click the spot it is about.</div>';
    if (open != null) show(open);
  }
  function place(el, x, y) {
    const w = Math.min(300, innerWidth - 24);
    el.style.left = Math.max(scrollX + 12, Math.min(x + 16, scrollX + innerWidth - w - 12)) + 'px';
    el.style.top = y + 16 + 'px';
  }
  function show(i) {
    root.querySelectorAll('.bubble').forEach((b) => b.remove());
    open = i; if (i == null || !notes[i]) { open = null; return; }
    const n = notes[i], s = spotOf(n), b = document.createElement('div');
    b.className = 'bubble';
    b.innerHTML = `<b>${i + 1} · ${esc(n.name)}</b><p>${esc(n.text)}</p><small>${esc(when(n.created))}${earlier(n) ? ' · earlier version' : ''}</small>`;
    pins.appendChild(b); place(b, s.x, s.y);
  }
  async function send(fields) {
    const { ok, body } = await request('POST', { ...fields, page });
    if (!ok) throw Error(body?.error || 'The note did not send.');
    return body;
  }
  // Pasted "Section: note" lines (3.7): each is pinned to the heading of that name, else to the top of the page.
  const same = (a, b) => a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
  function pasteSpot(section) {
    const heading = [...document.querySelectorAll('h1,h2,h3')].find((h) => section && same(h.textContent, section));
    if (!heading) return { anchor: null, fx: null, fy: null, px: 0.5, py: 0.05 };
    // Just past the heading's words, so the pin never covers them.
    const r = heading.getBoundingClientRect(), d = docSize(), words = document.createRange();
    words.selectNodeContents(heading);
    const fx = r.width ? Math.min(1, (words.getBoundingClientRect().right - r.left + 20) / r.width) : 0;
    return { anchor: pathOf(heading), fx, fy: 0.5, px: (r.left + fx * r.width + scrollX) / d.w, py: (r.top + scrollY + r.height / 2) / d.h };
  }
  pastebox.onsubmit = async (e) => {
    e.preventDefault();
    const area = pastebox.querySelector('textarea'), name = pastebox.querySelector('input'), err = pastebox.querySelector('.row span'), go = pastebox.querySelector('.go');
    const lines = area.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    err.textContent = '';
    if (!lines.length) { err.textContent = 'Paste at least one note.'; return; }
    if (!name.value.trim()) { err.textContent = 'Add your name.'; return; }
    store.set('name', name.value.trim()); go.disabled = true;
    let sent = 0;
    try {
      for (const line of lines) {
        const m = /^([^:]{1,80}):\s*(.+)$/.exec(line), spot = pasteSpot(m ? m[1] : '');
        // The whole line is kept, so the section name travels with the note to Tris and the model.
        notes.push(await send({ ...spot, text: line, name: name.value }));
        sent++;
      }
      area.value = ''; pastebox.hidden = true;
    } catch (problem) { err.textContent = (sent ? sent + ' sent. ' : '') + (problem.message || 'The notes did not send.'); area.value = lines.slice(sent).join('\n'); }
    go.disabled = false; draw();
  };
  async function load() {
    try {
      const { ok, body } = await request('GET');
      if (ok && Array.isArray(body)) { notes = body; draw(); }
    } catch {}
  }
  function arm(on) {
    shield.hidden = hint.hidden = !on; add.setAttribute('aria-pressed', String(on));
    if (on) { show(null); closeComposer(); }
  }
  function closeComposer() { composer?.remove(); composer = null; }
  function compose(spot, x, y) {
    closeComposer();
    const c = document.createElement('form');
    c.className = 'composer';
    c.innerHTML = `<textarea aria-label="Your note" placeholder="Your note"></textarea><input aria-label="Your name" placeholder="Your name" maxlength="60"><div class="row"><span></span><button type="button" class="cancel">Cancel</button><button type="submit" class="go">Send</button></div>`;
    const text = c.querySelector('textarea'), name = c.querySelector('input'), err = c.querySelector('span');
    name.value = store.get('name');
    c.querySelector('.cancel').onclick = closeComposer;
    c.onsubmit = async (e) => {
      e.preventDefault(); err.textContent = '';
      if (!text.value.trim()) { err.textContent = 'Write your note first.'; return; }
      if (!name.value.trim()) { err.textContent = 'Add your name.'; return; }
      store.set('name', name.value.trim());
      const go = c.querySelector('.go'); go.disabled = true; go.textContent = 'Sending…';
      try {
        notes.push(await send({ ...spot, text: text.value, name: name.value })); closeComposer(); draw(); show(notes.length - 1);
      } catch (problem) { err.textContent = problem.message || 'The note did not send. Try again.'; go.disabled = false; go.textContent = 'Send'; }
    };
    pins.appendChild(c); place(c, x, y); composer = c;
    (name.value ? text : name).focus();
  }
  shield.addEventListener('click', (e) => {
    arm(false);
    host.style.display = 'none';
    const target = document.elementFromPoint(e.clientX, e.clientY) || document.body;
    host.style.display = '';
    const r = target.getBoundingClientRect(), d = docSize(), x = e.clientX + scrollX, y = e.clientY + scrollY;
    compose({ anchor: pathOf(target), fx: r.width ? (e.clientX - r.left) / r.width : 0, fy: r.height ? (e.clientY - r.top) / r.height : 0, px: x / d.w, py: y / d.h }, x, y);
  });
  add.onclick = () => arm(add.getAttribute('aria-pressed') !== 'true');
  list.onclick = () => { panel.hidden = !panel.hidden; pastebox.hidden = true; };
  $('.pastebtn').onclick = () => {
    pastebox.hidden = !pastebox.hidden; panel.hidden = true;
    if (!pastebox.hidden) { const name = pastebox.querySelector('input'); name.value ||= store.get('name'); pastebox.querySelector('textarea').focus(); }
  };
  panel.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    const i = +li.dataset.i, s = spotOf(notes[i]);
    scrollTo({ top: Math.max(0, s.y - innerHeight / 3), behavior: 'smooth' }); show(i);
  });
  if (framed) addEventListener('message', (e) => {
    if (e.source !== parent || !e.data) return;
    if (e.data.koan === 'notes-reply' && waiting.has(e.data.id)) { waiting.get(e.data.id)(e.data); waiting.delete(e.data.id); }
    if (e.data.koan === 'notes-list') list.click();
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { arm(false); closeComposer(); show(null); } });
  addEventListener('resize', draw);
  addEventListener('load', draw);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => draw()).observe(document.body);
  load();
  setInterval(load, 60000);
})();
