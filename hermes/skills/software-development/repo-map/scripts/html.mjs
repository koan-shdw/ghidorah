import fs from 'node:fs/promises';
export async function renderHtml(map) {
  const query=await fs.readFile(new URL('./query.mjs',import.meta.url),'utf8');
  const view=await fs.readFile(new URL('./view.mjs',import.meta.url),'utf8');
  const script=query.replace(/^export /gm,'')+'\n'+view.replace(/^import[^\n]+\n/,'').replace(/^export /gm,'');
  const data=JSON.stringify(map).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"><title>Repository map</title><style>body{background:#0a111b;color:#e0e9f7;font:14px system-ui;margin:24px;--surface:#0e1927;--line:#28394d;--text:#e0e9f7;--muted:#91a4ba}h1{font-size:18px;font-weight:500}#view{max-width:1400px}</style></head><body><h1>Repository map · local snapshot</h1><div id="view"></div><script type="application/json" id="map-data">${data}</script><script>${script}\nmountGraph(document.getElementById('view'),JSON.parse(document.getElementById('map-data').textContent));</script></body></html>`;
}
