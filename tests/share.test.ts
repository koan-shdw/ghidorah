import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sections,pageLink,aiAddress,readyMessage,aiPage,noteMessages,notesForModel,hashPassword,privateId,stageSite,writeProject,databaseIdOf,deployedUrl,run,type ShareProject,type ShareNote} from '../app/share';

const project:ShareProject={id:'p',shareId:'AbCdEfGhIjKlMnOpQrStUv',chatId:'c',title:'Davan',page:'index.html',version:2,aiKey:'key123',sections:['Home','Pricing'],published:0,since:0};

test('share: the share site rules (share/test.mjs) pass',()=>{
 const result=spawnSync(process.execPath,['share/test.mjs'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr+result.stdout);assert.match(result.stdout,/PASS share site/);
});

test('share: sections are the h1 to h3 headings, as the notes layer reads them (3.7)',()=>{
 assert.deepEqual(sections('<h1>Home</h1><script>"<h2>no</h2>"</script><h2 class="x">Our <b>work</b>&amp; more</h2><h4>Skip</h4><h3>Pricing</h3><h3>Pricing</h3>'),['Home','Our work & more','Pricing']);
 assert.deepEqual(sections('<p>none</p>'),[]);
});

test('share: links, the AI address and the ready message (3.2, 3.7)',()=>{
 assert.equal(pageLink('https://s.dev',project),'https://s.dev/AbCdEfGhIjKlMnOpQrStUv/');
 assert.equal(pageLink('https://s.dev',{...project,page:'about us.html'}),'https://s.dev/AbCdEfGhIjKlMnOpQrStUv/about%20us.html');
 assert.equal(aiAddress('https://s.dev',project),'https://s.dev/AbCdEfGhIjKlMnOpQrStUv/for-ai','no key without a password');
 const locked={...project,password:hashPassword('open sesame')};
 assert.equal(aiAddress('https://s.dev',locked),'https://s.dev/AbCdEfGhIjKlMnOpQrStUv/for-ai?key=key123','an AI cannot type a password, so its address carries a key');
 assert.equal(readyMessage('https://s.dev',project),'Read https://s.dev/AbCdEfGhIjKlMnOpQrStUv/for-ai and help me give notes on https://s.dev/AbCdEfGhIjKlMnOpQrStUv/.');
 const page=aiPage('WHAT THIS PROJECT IS\nA site.\n',{sections:project.sections,version:2});
 assert.match(page,/^WHAT THIS PROJECT IS\nA site\.\n\nHOW TO WRITE NOTES\nWrite one line per note, as: Section: note\nSections on this page: Home; Pricing\n/);
 assert.match(privateId(),/^[A-Za-z0-9_-]{22}$/);
 const first=hashPassword('x'),second=hashPassword('x');assert.notEqual(first.salt,second.salt);assert.equal(hashPassword('x',first.salt).hash,first.hash);
});

test('share: what Koan is told and what the model gets (3.4)',()=>{
 const note=(name:string,version:number|null,text:string):ShareNote=>({id:name+text,shareId:project.shareId,projectId:'p',page:'/'+project.shareId+'/',name,text,anchor:null,version,created:1});
 const notes=[note('Ana',2,'Header: bigger logo'),note('Ana',2,'Pricing: add yearly'),note('Ben',1,'Too dark')];
 assert.deepEqual(noteMessages('Davan',notes),['Davan: Ana left 2 notes on the page','Davan: Ben left 1 note on the page']);
 assert.equal(notesForModel('https://s.dev/x/',2,notes),'Client notes on https://s.dev/x/ (version 2):\n- Ana: Header: bigger logo\n- Ana: Pricing: add yearly\n- Ben (on version 1): Too dark');
});

test('share: the site folder and a project folder (3.1, 3.5)',async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'tris-share-')),site=path.join(temp,'site');
 try{
  await fs.mkdir(path.join(site,'public','Published0000000000001'),{recursive:true});await fs.writeFile(path.join(site,'public','Published0000000000001','index.html'),'kept');
  await stageSite(path.resolve('share'),site,'db-id-1');
  assert.equal(await fs.readFile(path.join(site,'public','Published0000000000001','index.html'),'utf8'),'kept','published pages are never overwritten');
  assert.equal(await fs.readFile(path.join(site,'src','worker.js'),'utf8'),await fs.readFile('share/src/worker.js','utf8'),'the Worker follows the app');
  assert.equal(await fs.access(path.join(site,'public','B9c4757rgb9ELNNxQBJktw')).then(()=>true,()=>false),false,'only the notes layer comes from the app, never the repo’s own test page');
  const config=JSON.parse(await fs.readFile(path.join(site,'wrangler.jsonc'),'utf8'));assert.equal(config.d1_databases[0].database_id,'db-id-1');assert.equal(config.name,'koan-share');
  const folder=path.join(site,'public',project.shareId);
  await writeProject(site,{...project,ai:{text:'WHAT THIS PROJECT IS\nA site.',version:1}},new Map([['index.html',Buffer.from('<h1>v2</h1>')],['img/a.png',Buffer.from('png')]]));
  await fs.writeFile(path.join(folder,'old.html'),'old');
  await writeProject(site,{...project,version:3,password:{salt:'s',hash:'h'}},new Map([['index.html',Buffer.from('<h1>v3</h1>')]]));
  assert.deepEqual((await fs.readdir(folder)).sort(),['_share.json','for-ai.txt','index.html'],'a new version replaces the old files and keeps the AI page');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder,'_share.json'),'utf8')),{version:3,aiKey:'key123',password:{salt:'s',hash:'h'}});
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});

test('share: the installed app carries the share site (code rule 5)',async()=>{
 const shipped=JSON.parse(await fs.readFile('package.json','utf8')).build.extraResources.find((entry:any)=>entry.from==='share');
 assert.ok(shipped,'share\ is in the package');assert.equal(shipped.to,'share');
 for(const file of ['src/**/*','public/_notes/**/*','schema.sql','package.json'])assert.ok(shipped.filter.includes(file),file+' ships');
});

test('share: reading wrangler output, and only simple arguments',()=>{
 assert.equal(databaseIdOf('{"d1_databases":[{"database_name":"koan-share-notes","database_id": "f1ebd8a9-f1f3-4101-bbd8-e22ec2a9bc38"}]}'),'f1ebd8a9-f1f3-4101-bbd8-e22ec2a9bc38');
 assert.equal(databaseIdOf('database_id = "f1ebd8a9-f1f3-4101-bbd8-e22ec2a9bc38"'),'f1ebd8a9-f1f3-4101-bbd8-e22ec2a9bc38');
 assert.equal(deployedUrl('Uploaded koan-share\nDeployed koan-share triggers\n  https://koan-share.shdw-gallery.workers.dev\nCurrent Version ID: 1'),'https://koan-share.shdw-gallery.workers.dev');
 assert.equal(deployedUrl('  http://127.0.0.1:5123'),null,'a local address only counts in tests');
 assert.equal(deployedUrl('  http://127.0.0.1:5123',true),'http://127.0.0.1:5123');
 assert.throws(()=>run('wrangler.cmd',['d1','execute','--command','DROP TABLE notes'],'.'),/simple arguments/);
});
