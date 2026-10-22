import React,{useEffect,useState} from 'react';
import {parseTDF,render,cp437ToChar,decodeColor,CGA_PALETTE,type Cell} from '../third-party/taag/thedraw';
import fonts from '../third-party/taag/fonts.json';
export const artFontNames=Object.keys(fonts).sort((a,b)=>a.localeCompare(b));
export const defaultArtFont='PE Red';
export function WelcomeArt({font}:{font:string}){
  const [rows,setRows]=useState<Cell[][]>([]),[error,setError]=useState('');
  useEffect(()=>{let cancelled=false;setError('');void window.desktop.invoke('artFont',{font}).then(encoded=>{
    const loaded=parseTDF(Uint8Array.from(atob(encoded),character=>character.charCodeAt(0))).find(candidate=>candidate.name===font);
    if(!loaded)throw Error('Font unavailable');
    // One line (Koan 2026-10-17; renamed from Trismegistus 2026-10-16, the III icon stays).
    const rows=['ghidorah'].flatMap(line=>render(line,loaded,{mode:'cells'}).cells);
    if(!rows.length)throw Error('This font has no matching letters');
    if(!cancelled)setRows(rows);
  }).catch(()=>{if(!cancelled){setRows([]);setError('Artwork unavailable');}});return()=>{cancelled=true;};},[font]);
  const width=Math.max(1,...rows.map(row=>row.length))*8,height=Math.max(1,rows.length)*16;
  return rows.length?<svg className="welcome-art" role="img" aria-label="Ghidorah" data-font={font} viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
    {rows.map((row,y)=>row.map((cell,x)=>{const {fg,bg}=decodeColor(cell.colorAttr);return <g key={y+':'+x}>{bg!==0&&<rect x={x*8} y={y*16} width="8" height="16" fill={CGA_PALETTE[bg]}/>}<text x={x*8} y={y*16+13} fill={CGA_PALETTE[fg]}>{cp437ToChar(cell.charCode)}</text></g>;}))}
  </svg>:<div className="welcome-art-fallback" role="status">{error||'Ghidorah'}</div>;
}
