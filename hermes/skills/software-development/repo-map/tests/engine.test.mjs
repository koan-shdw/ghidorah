import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(skill, 'work');
const cli = path.join(skill, 'scripts/cli.mjs');
async function fixture(t) {
  await fs.mkdir(scratch, {recursive: true});
  const root = await fs.mkdtemp(path.join(scratch, 'test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const put = async (name, text) => {await fs.mkdir(path.dirname(path.join(root, name)), {recursive:true}); await fs.writeFile(path.join(root, name), text);};
  return {root, put};
}
import {generate} from '../scripts/cli.mjs';
import {contextText} from '../scripts/query.mjs';

const run = (root, ...args) => spawnSync(process.execPath, [cli, root, ...args], {encoding:'utf8', timeout:30000});

test('focused queries put the requested symbol ahead of unrelated declarations',async t=>{
 const {root,put}=await fixture(t);
 await put('src/large.ts',Array.from({length:10},(_,i)=>`export function unrelated${i}() {}`).join('\n')+'\nexport function launchFeature() {}\n');
 const {map}=await generate(root),text=contextText(map,{query:'launchFeature',budget:1500});
 assert.match(text,/11-11 export function launchFeature/);
 assert.ok(text.indexOf('launchFeature')<text.indexOf('unrelated0'));
 assert.ok(text.length<=1500);
 const cited=contextText(map,{file:'src/large.ts',line:11,budget:1500});
 assert.match(cited,/11-11 export function launchFeature/);assert.doesNotMatch(cited,/unrelated0/);
});

test('saved maps cannot validate themselves: missing and changed source fail check', async t => {
  const {root, put} = await fixture(t);
  await put('src/main.ts', 'export const count = 1;\n');
  assert.notEqual(run(root, '--check').status, 0, 'missing map must fail');
  assert.equal(run(root, '--no-html', '--quiet').status, 0);
  assert.equal(run(root, '--check').status, 0, 'unchanged source must pass');
  await put('src/main.ts', 'export const count = 2;\n');
  assert.notEqual(run(root, '--check').status, 0, 'same-size edit must fail');
});

test('AST outlines and file imports are real, including forward discovery and Python relatives', async t => {
  const {root,put} = await fixture(t);
  await put('app/main.ts', `// import fake from '../fake';\nimport {help} from '../zlib/helper.js';\nexport function start(value: string): number {return help(value);}\n`);
  await put('zlib/helper.ts', 'export const help = (value: string) => value.length;\n');
  await put('pkg/main.py', 'from .helper import help\ndef start(value: str) -> int:\n    return help(value)\n');
  await put('pkg/helper.py', 'def help(value):\n    return len(value)\n');
  const {map} = await generate(root);
  assert.ok(map.files.find(f=>f.path==='app/main.ts').symbols?.some(s=>s.name==='start' && s.line===3), 'extract actual definition and line');
  assert.ok(map.edges.some(e=>e.from==='app/main.ts' && e.to==='zlib/helper.ts'));
  assert.ok(map.edges.some(e=>e.from==='pkg/main.py' && e.to==='pkg/helper.py'));
  assert.ok(!map.edges.some(e=>e.to.includes('fake')));
  assert.equal(run(root,'--quiet','--no-html').status, 0);
  const cached = (await generate(root)).map;
  assert.equal(cached.stats.parsed, 0, 'content-identical files reuse parsed outlines');
  await put('zlib/helper.ts','export const help = (value: string) => value.trim().length;\n');
  assert.equal((await generate(root)).map.stats.parsed, 1);
});

test('task context is bounded and claims require explicit current evidence', async t => {
  const {root,put} = await fixture(t);
  await put('src/voice.ts', 'export function transcribeVoice() { return 1; }\n');
  await put('tests/voice.test.ts', "import {transcribeVoice} from '../src/voice';\n");
  const first=(await generate(root)).map, file=first.files.find(f=>f.path==='src/voice.ts');
  await put('REPO-MAP-NOTES.json',JSON.stringify({claims:[{kind:'purpose',text:'Voice entry point',evidence:[{path:file.path,hash:file.hash,line:1}]}]}));
  const noted=(await generate(root)).map;
  assert.equal(noted.claims?.[0]?.status,'current');
  const response=run(root,'--query','transcribe voice','--budget','1200');
  assert.equal(response.status,0,response.stderr);
  assert.ok(response.stdout.includes('src/voice.ts'));
  assert.ok(response.stdout.length<=1201,'budget is a hard character limit, not a token claim');
  await put('src/voice.ts','export function transcribeVoice() { return 2; }\n');
  assert.equal((await generate(root)).map.claims[0].status,'stale');
  await put('REPO-MAP-NOTES.json',JSON.stringify({claims:[{kind:'purpose',text:'Rewording alone must not refresh',evidence:[]}]}));
  assert.equal((await generate(root)).map.claims[0].status,'unverified');
});

test('a query reads the saved map instead of rebuilding it; --refresh rebuilds (Koan 2026-10-08)',async t=>{
 const {root,put}=await fixture(t);
 await put('src/alpha.ts','export function alphaFeature() {}\n');
 assert.equal(run(root,'--quiet').status,0);
 const saved=path.join(root,'.repo-map','index.json'),first=JSON.parse(await fs.readFile(saved,'utf8'));
 await put('src/beta.ts','export function betaFeature() {}\n');
 const query=run(root,'--query','betaFeature','--json');assert.equal(query.status,0,query.stderr);
 assert.equal(JSON.parse(query.stdout).generatedAt,first.generatedAt,'the query used the saved map');
 assert.equal(JSON.parse(await fs.readFile(saved,'utf8')).generatedAt,first.generatedAt,'the saved map was not rewritten');
 const refreshed=run(root,'--query','betaFeature','--json','--refresh');assert.equal(refreshed.status,0,refreshed.stderr);
 assert.ok(JSON.parse(refreshed.stdout).files.some(file=>file.path==='src/beta.ts'),'--refresh rebuilds first');
});
