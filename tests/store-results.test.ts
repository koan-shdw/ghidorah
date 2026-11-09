import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store,PREVIEW_CUT,PREVIEW_MARK} from '../app/store';
import {WorkCoordination} from '../app/work-coordination';
import type {ToolCall} from '../app/types';

// OUTPUTS 2026-11-09: long tool outputs live in the results table; tool and work-action rows carry previews and are
// never read all at once.
const long=(seed:string,n=20000)=>seed.repeat(Math.ceil(n/seed.length)).slice(0,n);
const fixture=()=>{const store=new Store(':memory:'),chat=store.chat(store.project().id),turn=store.accept('t1',chat.id,'Work');return {store,chat,turn};};
const count=(store:Store,sql:string)=>(store.db.prepare(sql).get() as any).n as number;

test('a long tool result is saved as a preview, the whole text in its own row',()=>{
  const {store,turn}=fixture(),result={exit_code:1,output:long('abc ')+'NEEDLE_7 at the end'};
  store.put<ToolCall>('tool',{id:'a',turnId:turn.id,name:'Bash',args:{},result,status:'failed'});
  const saved=JSON.parse((store.db.prepare("SELECT data FROM records WHERE kind='tool' AND id='a'").get() as any).data);
  assert.equal(saved.resultCut,true);assert.equal(saved.result.exit_code,1,'the preview keeps the shape');assert.ok(saved.result.output.endsWith(PREVIEW_MARK));assert.ok(saved.result.output.length<=PREVIEW_CUT+PREVIEW_MARK.length);
  assert.deepEqual(store.whole('tool',store.get('tool','a')),result);
  const {resultCut,...rest}=store.get<any>('tool','a');assert.deepEqual(store.withResults('tool',store.toolsOf([turn]))[0],{...rest,result});
  assert.deepEqual([...store.resultsContaining('tool',['a'],'needle_7')],['a'],'a search reaches inside the whole text');
  // A short result replaces it; the saved whole text goes with it.
  store.update<ToolCall>('tool','a',{result:'ok',status:'completed'});
  assert.equal(store.get<ToolCall>('tool','a').resultCut,undefined);assert.equal(count(store,'SELECT count(*) AS n FROM results'),0);
  // A re-saved preview row (a status change) keeps its whole text.
  store.update<ToolCall>('tool','a',{result});store.update<ToolCall>('tool','a',{status:'stopped'});
  assert.deepEqual(store.whole('tool',store.get('tool','a')),result);
  store.remove('tool','a');assert.equal(count(store,'SELECT count(*) AS n FROM results'),0);
  // A result that is long without long strings is cut as text.
  store.put<ToolCall>('tool',{id:'b',turnId:turn.id,name:'Read',args:{},result:{rows:Array.from({length:3000},(_,i)=>({i}))},status:'completed'});
  assert.ok(typeof store.get<ToolCall>('tool','b').result==='string');assert.equal(store.whole('tool',store.get('tool','b')).rows.length,3000);
  assert.throws(()=>store.all('tool'),/by turn/);assert.throws(()=>store.all('work-action'),/by turn/);
  store.db.close();
});

test('a finished action keeps a preview and its tool row the whole result; an uncertain action keeps its own',async()=>{
  const {store,turn}=fixture(),owner=new WorkCoordination(store),signal=new AbortController().signal,directory=await fs.mkdtemp(path.join(os.tmpdir(),'tris-results-'));
  const result={exit_code:0,output:long('line\n')},other={exit_code:null,output:long('still running\n')};
  const lease=(await owner.begin('group',turn.id,directory,'Bash',{command:'build'},signal))!;
  store.update<any>('work-action',lease,{toolId:'call-1'});store.put<ToolCall>('tool',{id:'call-1',turnId:turn.id,name:'Bash',args:{command:'build'},status:'running',result:null});
  await owner.finish(lease,turn.id,result);
  const action=store.get<any>('work-action',lease);
  assert.equal(action.status,'completed');assert.equal(action.resultCut,true);assert.ok(action.result.output.endsWith(PREVIEW_MARK));
  assert.equal(count(store,"SELECT count(*) AS n FROM results WHERE kind='work-action'"),0,'the action row holds no second copy');
  assert.deepEqual(store.whole('tool',store.get('tool','call-1')),result);assert.deepEqual(store.whole('work-action',action),result,'read through its tool row');
  const uncertain=(await owner.begin('group',turn.id,directory,'Bash',{command:'deploy'},signal))!;
  await owner.finish(uncertain,turn.id,other,true);
  const pending=store.get<any>('work-action',uncertain);
  assert.equal(pending.status,'uncertain');assert.equal(pending.resultCut,true);assert.deepEqual(store.whole('work-action',pending),other,'kept whole while uncertain');
  assert.equal(owner.records('group').length,2);assert.ok(owner.records('group').every(row=>JSON.stringify(row).length<3*PREVIEW_CUT));
  const restored=new WorkCoordination(store);restored.interrupt();assert.equal(restored.pending().length,1);
  store.db.close();await fs.rm(directory,{recursive:true,force:true});
});

test('rows saved whole by earlier versions move to the results table a batch at a time',()=>{
  const {store,turn}=fixture(),result={output:long('x')};
  const old=(kind:string,value:any)=>store.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?)').run(kind,value.id,JSON.stringify(value));
  for(let i=0;i<5;i++)old('tool',{id:'t'+i,turnId:turn.id,name:'Bash',args:{},result,status:'completed'});
  old('work-action',{id:'w0',toolId:'t0',job:turn.id,group:'g',name:'Bash',args:{},resource:'.',access:'write',signature:'s',status:'completed',result});
  old('work-action',{id:'w9',toolId:'missing',job:turn.id,group:'g',name:'Bash',args:{},resource:'.',access:'write',signature:'s2',status:'completed',result});
  old('tool',{id:'short',turnId:turn.id,name:'Read',args:{},result:'small',status:'completed'});
  let passes=0;while(!store.splitResults(2))passes++;
  assert.ok(passes>=3,'small batches');assert.equal(store.splitResults(),true,'remembered as done');
  for(const tool of store.toolsOf([turn]))if(tool.id!=='short'){assert.equal(tool.resultCut,true);assert.equal(tool.started,undefined,'old rows are not stamped');assert.deepEqual(store.whole('tool',tool),result);}
  assert.equal(store.get<any>('tool','short').resultCut,undefined);
  const w0=store.get<any>('work-action','w0'),w9=store.get<any>('work-action','w9');
  assert.equal(w0.resultCut,true);assert.deepEqual(store.whole('work-action',w0),result);assert.deepEqual(store.whole('work-action',w9),result);
  assert.equal(count(store,"SELECT count(*) AS n FROM results WHERE kind='work-action'"),1,'only the action with no tool row keeps its own copy');
  assert.ok(count(store,"SELECT sum(length(data)) AS n FROM records WHERE kind IN ('tool','work-action')")<8*3*PREVIEW_CUT);
  store.db.close();
});

test('startup and the end of a reply read open rows only, whatever the saved volume',()=>{
  const {store,turn}=fixture(),result={exit_code:0,output:long('output ',10000)};
  store.transaction(()=>{for(let i=0;i<3000;i++){store.put<ToolCall>('tool',{id:'t'+i,turnId:turn.id,name:'Bash',args:{},result,status:'completed'});store.put('work-action',{id:'w'+i,toolId:'t'+i,job:turn.id,group:'g',name:'Bash',args:{},resource:'.',access:'write',signature:'s'+i,status:'completed',result});}});
  const started=performance.now();
  store.interrupt();const owner=new WorkCoordination(store);owner.interrupt();
  assert.ok(performance.now()-started<1000,`open-row reads took ${(performance.now()-started).toFixed(0)} ms`);
  store.db.close();
});
