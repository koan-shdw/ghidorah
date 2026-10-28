import React,{useEffect,useState} from 'react';
import {parseTDF,render,cp437ToChar,decodeColor,CGA_PALETTE} from '../third-party/taag/thedraw';
import fonts from '../third-party/taag/fonts.json';
export const artFontNames=Object.keys(fonts).sort((a,b)=>a.localeCompare(b));
export const defaultArtFont='PE Red';

// The artwork is drawn once per font and kept as markup: a new chat shows it at once instead of rebuilding a few
// thousand shapes, and the app prepares it when it opens (Koan 2026-10-28: new chats flashed a placeholder first).
type Art={markup:string;width:number;height:number}|null;
const ready=new Map<string,Art>(),loading=new Map<string,Promise<Art>>();
const escape=(text:string)=>text.replace(/[&<>"]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[character]!));
export function loadArt(font:string):Promise<Art>{
  if(ready.has(font))return Promise.resolve(ready.get(font)!);
  let pending=loading.get(font);
  if(!pending){
    pending=window.desktop.invoke('artFont',{font}).then((encoded:string)=>{
      const loaded=parseTDF(Uint8Array.from(atob(encoded),character=>character.charCodeAt(0))).find(candidate=>candidate.name===font);
      if(!loaded)throw Error('Font unavailable');
      // One line (Koan 2026-10-17; renamed from Trismegistus 2026-10-16, the III icon stays).
      const rows=['ghidorah'].flatMap(line=>render(line,loaded,{mode:'cells'}).cells);
      if(!rows.length)throw Error('This font has no matching letters');
      const width=Math.max(1,...rows.map(row=>row.length))*8,height=Math.max(1,rows.length)*16;
      const cells=rows.map((row,y)=>row.map((cell,x)=>{const {fg,bg}=decodeColor(cell.colorAttr);return (bg!==0?`<rect x="${x*8}" y="${y*16}" width="8" height="16" fill="${CGA_PALETTE[bg]}"/>`:'')+`<text x="${x*8}" y="${y*16+13}" fill="${CGA_PALETTE[fg]}">${escape(cp437ToChar(cell.charCode))}</text>`;}).join('')).join('');
      return {markup:`<svg class="welcome-art" role="img" aria-label="Ghidorah" data-font="${escape(font)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${cells}</svg>`,width,height};
    }).catch(()=>null).then((art:Art)=>{ready.set(font,art);loading.delete(font);return art;});
    loading.set(font,pending);
  }
  return pending;
}
export function WelcomeArt({font}:{font:string}){
  const [art,setArt]=useState<Art|undefined>(()=>ready.get(font));
  useEffect(()=>{let cancelled=false;setArt(ready.get(font));void loadArt(font).then(value=>{if(!cancelled)setArt(value);});return()=>{cancelled=true;};},[font]);
  // Until the first drawing is ready the space stays empty: no stand-in word that then jumps to the artwork.
  if(art===undefined)return <div className="welcome-art-pending" aria-hidden="true"/>;
  return art?<div className="welcome-art-frame" dangerouslySetInnerHTML={{__html:art.markup}}/>:<div className="welcome-art-fallback" role="status">Artwork unavailable</div>;
}
