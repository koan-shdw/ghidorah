import fs from 'node:fs/promises';
import {NOTES, safePath, hash} from './inventory.mjs';

export async function readClaims(root, files) {
  let text;
  try {const file=await safePath(root,NOTES); if((await fs.stat(file)).size>100000)throw Error('Notes exceed 100 KB.');text=await fs.readFile(file,'utf8');}
  catch(error){return {claims:[],notesHash:null,notesError:error.code==='ENOENT'?'':'Notes unreadable, linked or over limit.'};}
  try {
    const raw=JSON.parse(text), byPath=new Map(files.map(f=>[f.path,f]));
    if(!Array.isArray(raw.claims)||raw.claims.length>100)throw Error('Use schema 2 claims with evidence; legacy notes are not silently trusted.');
    const claims=raw.claims.map(row=>{
      if(!row || typeof row.text!=='string'||!row.text.trim()||row.text.length>1200||!['purpose','flow','invariant','area'].includes(row.kind)||!Array.isArray(row.evidence)||row.evidence.length>30)throw Error('Invalid claim.');
      const evidence=row.evidence.map(e=>{
        if(!e||typeof e.path!=='string'||!e.path||typeof e.hash!=='string'||!/^[a-f\d]{64}$/.test(e.hash)||!Number.isSafeInteger(e.line)||e.line<1)throw Error('Evidence requires path, SHA-256 and line.');
        return {path:e.path,hash:e.hash,line:e.line};
      });
      const status=!evidence.length?'unverified':evidence.every(e=>byPath.get(e.path)?.hash===e.hash&&e.line<=byPath.get(e.path).lines)?'current':'stale';
      return {kind:row.kind,text:row.text,evidence,status};
    });
    return {claims,notesHash:hash(text),notesError:''};
  }catch(error){return {claims:[],notesHash:hash(text),notesError:error.message};}
}
