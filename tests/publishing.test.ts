import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pageBundle,pageFiles,readPublishing} from '../app/publishing';

test('publishing settings retain destination defaults',()=>{
 assert.deepEqual(readPublishing(undefined),{destination:'cloudflare',repository:'',branch:'main',site:''});
 assert.deepEqual(readPublishing({destination:'github',repository:' https://github.com/k/pages.git ',site:'https://k.github.io/pages/'}),{destination:'github',repository:'https://github.com/k/pages.git',branch:'gh-pages',site:'https://k.github.io/pages'});
 assert.equal(readPublishing({branch:'bad branch;'}).branch,'main');
});

test('the frozen bundle includes transitive CSS/modules and rejects private or escaped paths',async()=>{
 const root=await fs.mkdtemp(path.join(path.resolve('work'),'publish-assets-')),site=path.join(root,'site');
 const write=async(file:string,text:string)=>{const target=path.join(site,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,text);};
 try{
  await write('style.css','@import "css/more.css"; h1{background:url("img/a.svg")}');
  await write('css/more.css','@font-face {src:url(../font.woff2)}');
  await write('font.woff2','font');await write('img/a.svg','<svg></svg>');await write('img/b.svg','<svg></svg>');
  await write('app.js',`import {value} from './modules/a.js'; export * from './modules/b.js'; import('./modules/lazy.js'); const url=new URL('./data.json',import.meta.url); /* import './missing.js' */ const description="import './not-real.js'";`);
  await write('modules/a.js','export const value=1;');await write('modules/b.js','export const other=2;');await write('modules/lazy.js',"fetch('../extra.json');");await write('data.json','{}');await write('extra.json','{}');
  await write('keys.txt','private fixture');await write('.private/secret.js','const privateFixture=true;');
  const html='<link rel=stylesheet href="style.css?v=2"><script type="module" src="app.js"></script><style>p{background:url(img/b.svg)}</style><img srcset="data:image/svg+xml;base64,PHN2Zz4= 1x, img/a.svg 2x"><a href="https://example.invalid/">External</a>';
  await write('index.html',html);
  const bundle=await pageBundle(path.join(site,'index.html'));
  assert.deepEqual([...bundle.keys()].map(file=>file.replaceAll('\\','/')).sort(),['app.js','css/more.css','data.json','extra.json','font.woff2','img/a.svg','img/b.svg','index.html','modules/a.js','modules/b.js','modules/lazy.js','style.css']);
  await write('index.html','changed');assert.equal(bundle.get('index.html')!.toString(),html,'publish uses the bytes that were inspected');
  const outside=path.join(root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'private.js'),'private');await fs.symlink(outside,path.join(site,'linked'),'junction');
  for(const href of ['linked/private.js','../outside/private.js','.private/secret.js','%2e%2e/outside/private.js']){
   await write('index.html','<script src="'+href+'"></script>');await assert.rejects(pageFiles(path.join(site,'index.html')),/outside|inside|Private/);
  }
  await fs.symlink(path.join(site,'.private'),path.join(site,'alias'),'junction');await write('index.html','<script src="alias/secret.js"></script>');await assert.rejects(pageFiles(path.join(site,'index.html')),/Private/);
  await write('auth.json','{"encrypted":"private fixture"}');await write('index.html','<a href="auth.json">Download</a>');await assert.rejects(pageFiles(path.join(site,'index.html')),/Private/);
  await write('index.html','<img src="missing.svg">');await assert.rejects(pageFiles(path.join(site,'index.html')),/ENOENT/);
  await write('index.html','<script type="module">import(name)</script>');await assert.rejects(pageFiles(path.join(site,'index.html')),/dynamic module/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

// Real Git plumbing against a local bare remote: no credentials or public service.
test('publishing sends inspected bytes, preserves other pages, and runs no repository helpers',async()=>{
 const {execFileSync}=await import('node:child_process'),sync=await import('node:fs'),{createHash}=await import('node:crypto'),{publishPage}=await import('../app/publishing');
 const root=await fs.mkdtemp(path.join(path.resolve('work'),'publish-git-')),remote=path.join(root,'remote.git'),seed=path.join(root,'seed'),site=path.join(root,'site'),clone=path.join(root,'cache');
 const names=['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL'] as const,environment=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']}).toString().trim();
 try{
  Object.assign(process.env,{GIT_CONFIG_GLOBAL:path.join(root,'config'),GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'});
  await fs.writeFile(path.join(root,'config'),'');await fs.mkdir(seed);await fs.mkdir(site);
  git(root,'init','--bare','-q',remote);git(seed,'init','-q','-b','main');await fs.writeFile(path.join(seed,'.gitattributes'),'* filter=poison\n');await fs.writeFile(path.join(seed,'unrelated.txt'),'Keep this');git(seed,'add','.');git(seed,'commit','-qm','Seed');git(seed,'remote','add','origin',remote);git(seed,'push','-q','origin','main');
  const marker=path.join(root,'helper-ran'),helper=path.join(root,'filter.cjs');await fs.writeFile(helper,'require("node:fs").writeFileSync('+JSON.stringify(marker)+',"ran");process.stdin.pipe(process.stdout)');
  git(seed,'config','--global','filter.poison.clean','"'+process.execPath+'" "'+helper+'"');git(seed,'config','--global','filter.poison.required','true');
  const hooks=path.join(root,'hooks');await fs.mkdir(hooks);await fs.writeFile(path.join(hooks,'pre-push'),'#!/bin/sh\n"'+process.execPath.replaceAll('\\','/')+'" "'+helper.replaceAll('\\','/')+'"\n');git(seed,'config','--global','core.hooksPath',hooks);
  const page=path.join(site,'index.html'),html='<link href="style.css"><h1>Original page</h1>';await fs.writeFile(page,html);await fs.writeFile(path.join(site,'style.css'),'h1{color:teal}');
  const settings={destination:'cloudflare' as const,repository:remote,branch:'main',site:'http://127.0.0.1:1'};
  let changed=false;const first=await publishPage({page,settings,clone,wait:0,secret:text=>{if(text.includes('Original page')&&!changed){changed=true;sync.writeFileSync(page,'secret0-changed-after-inspection');}return text.includes('secret0');}});
  const slug='index-'+createHash('sha256').update(path.resolve(page).toLowerCase()).digest('hex').slice(0,6);
  assert.equal(first.live,false);assert.equal(git(root,'--git-dir',remote,'show','main:'+slug+'/index.html'),html);assert.equal(git(root,'--git-dir',remote,'show','main:unrelated.txt'),'Keep this');assert.equal(sync.existsSync(marker),false,'neither global filters nor hooks run');
  await assert.rejects(publishPage({page,settings,clone,wait:0,secret:text=>text.includes('secret0')}),/holds a credential/);
  await fs.writeFile(page,'<h1>Updated page</h1>');await publishPage({page,settings,clone,wait:0,secret:()=>false});
  const tree=git(root,'--git-dir',remote,'ls-tree','-r','--name-only','main').split('\n');assert.equal(tree.includes(slug+'/style.css'),false,'removed assets are removed from this page only');assert.ok(tree.includes('unrelated.txt'));
  const before=git(root,'--git-dir',remote,'rev-parse','main');await publishPage({page,settings,clone,wait:0,secret:()=>false});assert.equal(git(root,'--git-dir',remote,'rev-parse','main'),before,'identical publish adds no commit');
  await fs.writeFile(path.join(site,'two.html'),'<h1>Second page</h1>');await fs.writeFile(path.join(site,'three.html'),'<h1>Third page</h1>');await Promise.all(['two.html','three.html'].map(name=>publishPage({page:path.join(site,name),settings,clone,wait:0,secret:()=>false})));
  const final=git(root,'--git-dir',remote,'ls-tree','-r','--name-only','main');assert.match(final,/two-[a-f0-9]{6}\/two\.html/);assert.match(final,/three-[a-f0-9]{6}\/three\.html/);assert.equal(sync.existsSync(marker),false);
 }finally{for(const name of names){if(environment[name]===undefined)delete process.env[name];else process.env[name]=environment[name];}await fs.rm(root,{recursive:true,force:true});}
});
