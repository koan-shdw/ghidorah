// The style check: every value in the app's stylesheets comes from app/tokens.css and app/themes.css. It fails on a
// colour, text size, corner or layer written as a literal, a variable nobody defines, and a selector defined more
// times than scripts/style-baseline.json allows (the baseline only shrinks). Run: node scripts/style-check.mjs
// [--update] · npm test runs it through tests/style-check.test.ts.
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..'),app=path.join(root,'app'),baselineFile=path.join(import.meta.dirname,'style-baseline.json');
const TOKEN_FILES=new Set(['tokens.css','themes.css']);

// Top-level rules of a stylesheet as [selector, body], with @media/@container blocks opened up.
function rules(text){
  text=text.replace(/\/\*[\s\S]*?\*\//g,'');
  const out=[];let depth=0,start=0,head='';
  for(let i=0;i<text.length;i++){
    if(text[i]==='{'){if(depth===0){head=text.slice(start,i).trim();start=i+1;}depth++;}
    else if(text[i]==='}'){depth--;if(depth===0){const body=text.slice(start,i);
      if(head.startsWith('@keyframes')){}else if(head.startsWith('@'))out.push(...rules(body).map(([s,b,inner])=>[s,b,head]));else out.push([head,body,'']);start=i+1;}}
  }
  return out;
}
const declarations=body=>body.split(';').map(d=>d.trim()).filter(d=>d.includes(':')).map(d=>{const i=d.indexOf(':');return [d.slice(0,i).trim().toLowerCase(),d.slice(i+1).trim()];});

export function styleProblems({update=false}={}){
  const files=fs.readdirSync(app).filter(f=>f.endsWith('.css')).sort();
  const sources=Object.fromEntries(files.map(f=>[f,fs.readFileSync(path.join(app,f),'utf8')]));
  // Variables: defined in any stylesheet, or set from components (style props and setProperty).
  const defined=new Set();
  for(const text of Object.values(sources))for(const m of text.matchAll(/(--[\w-]+)\s*:/g))defined.add(m[1]);
  for(const f of fs.readdirSync(app).filter(f=>/\.tsx?$/.test(f)))for(const m of fs.readFileSync(path.join(app,f),'utf8').matchAll(/['"](--[\w-]+)['"]/g))defined.add(m[1]);
  const problems=[],duplicates={};
  for(const file of files){
    if(TOKEN_FILES.has(file))continue;
    const seen={};
    for(const [selector,body,media] of rules(sources[file])){
      const where=file+' '+(media?media+' ':'')+selector;
      if(!media)seen[selector]=(seen[selector]||0)+1;
      for(const [prop,value] of declarations(body)){
        if(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i.test(value))problems.push(where+' · colour literal in '+prop+': '+value+' (use a themes.css token)');
        if(prop==='font-size'&&!/^(var\(--fs-[\w-]+\)|[\d.]+em|[\d.]+%|inherit)(!important)?$/.test(value))problems.push(where+' · font-size '+value+' (use a --fs- token)');
        if(prop==='font'&&/^\d/.test(value))problems.push(where+' · font size in shorthand: '+value+' (use a --fs- token)');
        if(/radius$/.test(prop)&&!value.replace('!important','').split(/\s+/).every(v=>/^(0|inherit|var\(--r[\w-]*\))$/.test(v)))problems.push(where+' · '+prop+' '+value+' (use a --r token)');
        if(prop==='z-index'&&!/^(var\(--z-[\w-]+\)|auto|0)$/.test(value))problems.push(where+' · z-index '+value+' (use a --z- token)');
        for(const m of value.matchAll(/var\((--[\w-]+)/g))if(!defined.has(m[1]))problems.push(where+' · '+m[1]+' is never defined');
      }
    }
    for(const [selector,count] of Object.entries(seen))if(count>1)duplicates[file+' '+selector]=count;
  }
  const baseline=fs.existsSync(baselineFile)?JSON.parse(fs.readFileSync(baselineFile,'utf8')):{};
  if(update){fs.writeFileSync(baselineFile,JSON.stringify(duplicates,null,1)+'\n');return problems;}
  for(const [key,count] of Object.entries(duplicates))if(count>(baseline[key]||1))problems.push(key+' · defined '+count+' times (baseline '+(baseline[key]||1)+'): add to the existing rule instead');
  return problems;
}

if(import.meta.url===`file:///${process.argv[1].replace(/\\/g,'/')}`||process.argv[1]?.endsWith('style-check.mjs')){
  const problems=styleProblems({update:process.argv.includes('--update')});
  for(const p of problems)console.log(p);
  console.log(problems.length?problems.length+' style problems':'style check: clean');
  process.exit(problems.length?1:0);
}
