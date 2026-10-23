#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {inventory, readSaved, saveMap, SCHEMA} from './inventory.mjs';
import {ANALYZER, isJS, parseJS, parsePython, resolveImports} from './parsers.mjs';
import {readClaims} from './claims.mjs';
import {contextText} from './query.mjs';

export async function generate(root, options = {}) {
  const started=Date.now(), scan = await inventory(root, options), previous=await readSaved(scan.root);
  const cached=new Map((previous?.analyzer===ANALYZER?previous.files:[]).map(f=>[f.path,f]));
  const changed=scan.files.filter(f=>cached.get(f.path)?.hash!==f.hash || cached.get(f.path)?.status==='parser-unavailable');
  let pythonRows={};
  try {pythonRows=await parsePython(changed.filter(f=>f.path.endsWith('.py')),options.python);}
  catch {for(const f of changed.filter(f=>f.path.endsWith('.py')))pythonRows[f.path]={status:'parser-unavailable',symbols:[],imports:[]};}
  const files=scan.files.map(({text,...file})=>{
    const old=cached.get(file.path);
    if(old?.hash===file.hash && old.status!=='parser-unavailable')return old;
    const parsed=isJS(file.path)?parseJS({...file,text}):pythonRows[file.path]||{status:'inventory-only',symbols:[],imports:[]};
    return {...file,lines:text?text.replace(/\n$/,'').split('\n').length:0,...parsed};
  });
  const {edges,unresolved}=resolveImports(files);
  const issues=[...scan.issues,...files.filter(f=>['parse-error','parser-unavailable'].includes(f.status)).map(f=>({path:f.path,reason:f.status}))];
  const map = {schema:SCHEMA, analyzer:ANALYZER, repo:path.basename(scan.root), generatedAt:new Date().toISOString(), fingerprint:scan.fingerprint, partial:!!issues.length, scope:scan.scope, issues, files,edges,unresolved,stats:{parsed:changed.length,reused:files.length-changed.length,bytes:scan.bytes,milliseconds:Date.now()-started}};
  Object.assign(map,await readClaims(scan.root,files));
  return {root:scan.root,map};
}
export const indexText = map => contextText(map);
export async function main(argv = process.argv.slice(2)) {
  const values=new Set(['--query','--file','--budget','--python']), flags=new Set(['--check','--quiet','--json','--no-html','--html','--refresh']);
  const args={}; let root='.';
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(values.has(arg)){if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Missing value for '+arg);args[arg.slice(2)]=argv[++i];}
    else if(flags.has(arg))args[arg.slice(2)]=true;
    else if(arg.startsWith('--'))throw Error('Unknown option: '+arg);
    else if(i===0)root=arg;else throw Error('Repository root must be the first argument.');
  }
  root=path.resolve(root);
  if(args.check){
    const before=await readSaved(root), scan=await inventory(root), notes=await readClaims(scan.root,scan.files.map(f=>({...f,lines:f.text?f.text.replace(/\n$/,'').split('\n').length:0})));
    const ok=!!before&&before.analyzer===ANALYZER&&before.fingerprint===scan.fingerprint&&before.notesHash===notes.notesHash&&!before.partial&&!scan.issues.length&&!notes.notesError&&!notes.claims.some(c=>c.status!=='current');
    console.log(ok?'repo-map: current within declared scope':'repo-map: missing, stale, partial or unverified claims');
    if(!ok)process.exitCode=1;
    return;
  }
  // A query or file outline reads the saved map: the desktop refreshes it on commit and when its panel opens
  // (Koan, 2026-10-08). --refresh, a missing map or an older analyzer rebuild it first.
  const saved=(args.query!==undefined||args.file!==undefined)&&!args.refresh?await readSaved(root):null;
  if(saved?.analyzer===ANALYZER){const text=contextText(saved,{query:args.query||'',file:args.file||'',budget:args.budget?Number(args.budget):6000});if(args.json)console.log(JSON.stringify(saved));else if(!args.quiet)console.log(text);return;}
  const {root:absolute,map}=await generate(root,{python:args.python});
  await saveMap(absolute,map,indexText(map),args.html?await (await import('./html.mjs')).renderHtml(map):undefined);
  const text=contextText(map,{query:args.query||'',file:args.file||'',budget:args.budget?Number(args.budget):6000});
  if(args.json)console.log(JSON.stringify(map));else if(!args.quiet)console.log(text);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error('repo-map: '+error.message);process.exitCode=1;});
