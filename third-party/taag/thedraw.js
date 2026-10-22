// TAAG TheDraw renderer by patorjk. Personal local use; see NOTICE.md.
const mS = 0, hS = 2, pS = [0, 9786, 9787, 9829, 9830, 9827, 9824, 8226, 9688, 9675, 9689, 9794, 9792, 9834, 9835, 9788, 9658, 9668, 8597, 8252, 182, 167, 9644, 8616, 8593, 8595, 8594, 8592, 8735, 8596, 9650, 9660, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 8962, 199, 252, 233, 226, 228, 224, 229, 231, 234, 235, 232, 239, 238, 236, 196, 197, 201, 230, 198, 244, 246, 242, 251, 249, 255, 214, 220, 162, 163, 165, 8359, 402, 225, 237, 243, 250, 241, 209, 170, 186, 191, 8976, 172, 189, 188, 161, 171, 187, 9617, 9618, 9619, 9474, 9508, 9569, 9570, 9558, 9557, 9571, 9553, 9559, 9565, 9564, 9563, 9488, 9492, 9524, 9516, 9500, 9472, 9532, 9566, 9567, 9562, 9556, 9577, 9574, 9568, 9552, 9580, 9575, 9576, 9572, 9573, 9561, 9560, 9554, 9555, 9579, 9578, 9496, 9484, 9608, 9604, 9612, 9616, 9600, 945, 223, 915, 960, 931, 963, 181, 964, 934, 920, 937, 948, 8734, 966, 949, 8745, 8801, 177, 8805, 8804, 8992, 8993, 247, 8776, 176, 8729, 183, 8730, 8319, 178, 9632, 160];
function Es(n) {
  const a = pS[n & 255];
  return a !== void 0 ? String.fromCodePoint(a) : " ";
}
const $c = { A: 205, B: 196, C: 179, D: 186, E: 213, F: 187, G: 214, H: 191, I: 200, J: 190, K: 192, L: 189, M: 181, N: 199, O: 32, "@": 32, "&": 32 }, MT = 19, OT = 26, Xy = [84, 104, 101, 68, 114, 97, 119, 32, 70, 79, 78, 84, 83, 32, 102, 105, 108, 101], FT = 85, kT = 170, LT = 0, NT = 255, yS = 213, vS = 20, Wy = 94, zT = 65535, HT = 13, IT = 0, UT = 7;
function gS(n) {
  VT(n);
  const a = [];
  let s = vS;
  for (; s < n.length && !(n[s] !== FT || n[s + 1] !== kT || n[s + 2] !== LT || n[s + 3] !== NT); ) {
    const i = $T(n, s);
    a.push(i), s += yS + i._blockSize;
  }
  return a.map((i) => {
    const { _blockSize: r, ...f } = i;
    return f;
  });
}
function VT(n) {
  if (n.length < vS) throw new Error("Data too small to be a valid TDF file");
  if (n[0] !== MT) throw new Error(`Invalid TDF file: expected 0x13 at byte 0, got 0x${n[0].toString(16)}`);
  for (let a = 0; a < Xy.length; a++) if (n[1 + a] !== Xy[a]) throw new Error(`Invalid TDF file: magic string mismatch at byte ${1 + a}`);
  if (n[19] !== OT) throw new Error(`Invalid TDF file: expected 0x1A at byte 19, got 0x${n[19].toString(16)}`);
}
function Ky(n, a) {
  return n[a] | n[a + 1] << 8;
}
function jT(n, a, s) {
  let i = "";
  for (let r = 0; r < s; r++) {
    const f = n[a + r];
    if (f === 0) break;
    i += String.fromCharCode(f);
  }
  return i;
}
function $T(n, a) {
  const s = Math.min(n[a + 4], 12), i = jT(n, a + 5, s), r = n[a + 21], f = n[a + 22], b = Ky(n, a + 23), h = a + 25, d = a + yS, m = new Array(Wy).fill(void 0);
  for (let p = 0; p < Wy; p++) {
    const v = Ky(n, h + p * 2);
    if (v === zT) continue;
    const S = d + v;
    Object.defineProperty(m, p, { enumerable: true, configurable: true, get() {
      const C = qT(n, S, r);
      return Object.defineProperty(m, p, { value: C, enumerable: true, configurable: true, writable: true }), C;
    } });
  }
  return { name: i, type: r, letterSpacing: f, glyphs: m, _blockSize: b };
}
function qT(n, a, s) {
  a += 2;
  const i = [];
  let r = [];
  for (; a < n.length; ) {
    const f = n[a];
    if (f === IT) {
      r.length > 0 && i.push(r);
      break;
    }
    if (f === HT) {
      i.push(r), r = [], a++;
      continue;
    }
    s === hS ? (r.push({ charCode: f, colorAttr: n[a + 1] }), a += 2) : (r.push({ charCode: YT(f, s), colorAttr: UT }), a++);
  }
  return i;
}
function YT(n, a) {
  if (a !== mS) return n;
  const s = String.fromCharCode(n);
  return s in $c ? $c[s] : n;
}
const Ha = ["#000000", "#0000AA", "#00AA00", "#00AAAA", "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA", "#555555", "#5555FF", "#55FF55", "#55FFFF", "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF"], XT = "\x1B[0m";
function Ds(n) {
  return { fg: n & 15, bg: n >> 4 & 7 };
}
const Sc = [0, 4, 2, 6, 1, 5, 3, 7];
function SS(n) {
  const { fg: a, bg: s } = Ds(n), i = a < 8 ? 30 + Sc[a] : 90 + Sc[a - 8], r = 40 + Sc[s];
  return `\x1B[0;${i};${r}m`;
}
function _S(n) {
  var a, s;
  const { fg: i, bg: r } = Ds(n), f = (a = Ha[i]) !== null && a !== void 0 ? a : Ha[7];
  if (r === 0) return `color:${f}`;
  const b = (s = Ha[r]) !== null && s !== void 0 ? s : Ha[0];
  return `color:${f};background-color:${b}`;
}
const WT = { mode: "plain", htmlWrap: true, htmlClass: "tdf-art", htmlDocument: false, htmlBgColor: "#000000", spaceWidth: 1, transparentChar: " " }, $i = Object.freeze({ charCode: 32, colorAttr: 7 });
function KT(n, a, s = {}) {
  const i = { ...WT, ...s }, r = i.mode, f = ZT(n, a, i.spaceWidth);
  if (r === "cells") return { cells: f.map((b) => b.map((h) => ({ ...h }))) };
  if (r === "plain") return { text: QT(f, i.transparentChar) };
  if (r === "console" || r === "ansi") return { text: JT(f) };
  if (r === "html") return { text: eA(f, i) };
  throw new Error(`Unknown output mode: "${r}"`);
}
function ZT(n, a, s) {
  var i;
  if (n.length === 0) return [];
  const r = [];
  for (const m of n) {
    const p = m.charCodeAt(0);
    if (p === 32) {
      r.push([]);
      continue;
    }
    const v = p - 33;
    if (v < 0 || v >= 94) continue;
    const S = a.glyphs[v];
    S && S.length > 0 && r.push(S);
  }
  if (r.length === 0) return [];
  const f = r.reduce((m, p) => Math.max(m, p.length), 0);
  if (f === 0) return [];
  const b = Math.max(0, a.letterSpacing - 1), h = Array.from({ length: f }, () => []);
  let d = true;
  for (let m = 0; m < r.length; m++) {
    const p = r[m];
    if (!d && b > 0) for (let S = 0; S < f; S++) for (let C = 0; C < b; C++) h[S].push($i);
    if (p.length === 0) {
      const S = Math.max(1, s * 4);
      for (let C = 0; C < f; C++) for (let x = 0; x < S; x++) h[C].push($i);
      d = false;
      continue;
    }
    const v = p.reduce((S, C) => Math.max(S, C.length), 0);
    for (let S = 0; S < f; S++) {
      const C = p[S];
      if (C) for (let x = 0; x < v; x++) h[S].push((i = C[x]) !== null && i !== void 0 ? i : $i);
      else for (let x = 0; x < v; x++) h[S].push($i);
    }
    d = false;
  }
  return h;
}
function QT(n, a) {
  return n.map((s) => s.map((i) => {
    const r = Es(i.charCode);
    return r === "\0" ? a : r;
  }).join("")).join(`
`);
}
function JT(n) {
  const a = [];
  for (const s of n) {
    let i = "", r = -1;
    for (const f of s) {
      const b = f.colorAttr;
      b !== r && (i += SS(b), r = b), i += Es(f.charCode);
    }
    r !== -1 && (i += XT), a.push(i);
  }
  return a.join(`
`);
}
function eA(n, a) {
  const s = [];
  for (const b of n) {
    let h = "", d = -1, m = false;
    for (const p of b) {
      const v = p.colorAttr;
      if (v !== d) {
        m && (h += "</span>", m = false);
        const S = _S(v);
        h += `<span style="${S}">`, m = true, d = v;
      }
      h += tA(Es(p.charCode));
    }
    m && (h += "</span>"), s.push(h);
  }
  const i = s.join(`
`);
  if (!a.htmlWrap && !a.htmlDocument) return i;
  const f = `<pre${a.htmlClass ? ` class="${nA(a.htmlClass)}"` : ""} style="background-color:${a.htmlBgColor};margin:0;padding:0;line-height:1.2;font-family:monospace">${i}</pre>`;
  return a.htmlDocument ? `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TheDraw Font Art</title>
<style>
  body { background-color: ${a.htmlBgColor}; margin: 0; padding: 16px; }
  .tdf-art { display: inline-block; }
</style>
</head>
<body>
${f}
</body>
</html>` : f;
}
function tA(n) {
  return n.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function nA(n) {
  return n.replace(/"/g, "&quot;");
}
function lA(n) {
  return gS(n);
}
function aA(n, a) {
  const s = a.toLowerCase();
  return n.find((i) => i.name.toLowerCase().includes(s));
}
export {
  Ha as CGA_PALETTE,
  pS as CP437_TO_UNICODE,
  hS as FONT_TYPE_COLOR,
  mS as FONT_TYPE_OUTLINE,
  $c as OUTLINE_CHAR_MAP,
  SS as attrToAnsi,
  _S as attrToHtmlStyle,
  Es as cp437ToChar,
  Ds as decodeColor,
  aA as findFont,
  lA as loadTDF,
  gS as parseTDF,
  KT as render
};
