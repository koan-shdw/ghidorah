import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RepoMaps,gitHead} from '../app/repo-map-service';

test('desktop consumes the same CLI map, deduplicates work and refreshes on demand',async t=>{
 const root=await fs.mkdtemp(path.resolve('work/repo-map-service-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'entry.ts'),'export function begin() {}\n');
 const cli=path.resolve('hermes/skills/software-development/repo-map/scripts/cli.mjs');
 const service=new RepoMaps(cli,'python');
 const [first,parallel]=await Promise.all([service.refresh(root),service.refresh(root)]);
 assert.equal(first.fingerprint,parallel.fingerprint);
 assert.ok(first.files.some((f:any)=>f.symbols.some((s:any)=>s.name==='begin')));
 assert.match(await fs.readFile(path.join(root,'.repo-map/index.txt'),'utf8'),/begin/);
 await fs.writeFile(path.join(root,'entry.ts'),'export function changed() {}\n');
 assert.equal((await service.refresh(root)).fingerprint,first.fingerprint,'no new commit: the saved map is reused');
 assert.notEqual((await service.refresh(root,true)).fingerprint,first.fingerprint,'the refresh button picks up edits');
});

test('a failed worker releases the pending job so refresh can recover',async t=>{
 const root=await fs.mkdtemp(path.resolve('work/repo-map-service-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cli=path.join(root,'worker.mjs'),service=new RepoMaps(cli,'python');
 await fs.writeFile(cli,"throw Error('broken map worker');");
 await assert.rejects(service.refresh(root),/broken map worker/);
 await fs.writeFile(cli,"console.log(JSON.stringify({schema:2,files:[],edges:[]}));");
 assert.deepEqual((await service.refresh(root)).files,[]);
});

test('the repo map rebuilds only on a new commit or the refresh button (Koan, 2026-10-06)',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tris-map-')),repo=path.join(dir,'repo'),plain=path.join(dir,'plain'),runs=path.join(dir,'runs.txt'),cli=path.join(dir,'engine.mjs');
 // Stand-in engine: counts its runs and saves the index like the real one.
 await fs.writeFile(cli,`import fs from 'node:fs';import path from 'node:path';const root=process.argv[2];fs.appendFileSync(${JSON.stringify(runs)},'x');const map={schema:2,files:[],edges:[]};fs.mkdirSync(path.join(root,'.repo-map'),{recursive:true});fs.writeFileSync(path.join(root,'.repo-map','index.json'),JSON.stringify(map));process.stdout.write(JSON.stringify(map));`);
 await fs.mkdir(path.join(repo,'.git','refs','heads'),{recursive:true});await fs.mkdir(plain);
 await fs.writeFile(path.join(repo,'.git','HEAD'),'ref: refs/heads/main\n');await fs.writeFile(path.join(repo,'.git','refs','heads','main'),'aaa\n');
 const count=async()=>(await fs.readFile(runs,'utf8').catch(()=>'')).length,maps=new RepoMaps(cli,'python');
 assert.equal(await gitHead(repo),'aaa');assert.equal(await gitHead(plain),null);
 await maps.refresh(repo);assert.equal(await count(),1,'first open builds');
 await maps.refresh(repo);await maps.refresh(repo);assert.equal(await count(),1,'same commit: no rebuild, however often the page opens');
 await fs.writeFile(path.join(repo,'.git','refs','heads','main'),'bbb\n');
 await maps.refresh(repo);assert.equal(await count(),2,'new commit: one rebuild');
 await maps.refresh(repo,true);assert.equal(await count(),3,'the button forces a rebuild');
 await maps.refresh(plain);await maps.refresh(plain);assert.equal(await count(),4,'no Git: builds once');
});
