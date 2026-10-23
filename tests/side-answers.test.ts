import test from 'node:test';
import assert from 'node:assert/strict';
import {sideRoute,sideQuestion,saysMain,preferredSideModel,sideSystem,sideState} from '../app/side-answers';
import type {Turn,ToolCall} from '../app/types';

test('side answers: which way a message goes (FEATURE-SPECS 2.2, Koan 2026-10-10 "??")',()=>{
 const busy={running:true,attachments:false},idle={running:false,attachments:false};
 assert.equal(sideRoute('?? how far along are you',busy),'side');
 assert.equal(sideRoute('  ?? how far along are you',idle),'side','?? always goes to the floating box, even with nothing running');
 assert.equal(sideRoute('??',busy),'main','?? with no question is an ordinary message');
 assert.equal(sideRoute('how is it going?',busy),'sort','anything else sent while a turn runs is sorted');
 assert.equal(sideRoute('how is it going?',idle),'main','nothing running: exactly as before');
 assert.equal(sideRoute('also add tests',{running:true,attachments:true}),'main','attachments belong to the main model');
 assert.equal(sideRoute('/compact',busy),'main','commands are never sorted');
 assert.equal(sideQuestion('  ??  how far along?'),'how far along?');
});

test('side answers: the sorter hands MAIN (or nothing) to the main model',()=>{
 for(const reply of ['MAIN','main','MAIN.','"MAIN"','',' \n'])assert.equal(saysMain(reply),true,JSON.stringify(reply));
 for(const reply of ['It is editing ui.tsx.','Mainly done: two files left.'])assert.equal(saysMain(reply),false,reply);
 assert.match(sideSystem(false),/exactly MAIN/);assert.doesNotMatch(sideSystem(true),/MAIN/,'a ?? question is never sent back');
});

test('side answers: default model is the newest fast one he has connected',()=>{
 assert.equal(preferredSideModel(['claude-code:opus','claude-code:haiku','deepseek-flash']),'claude-code:haiku');
 assert.equal(preferredSideModel(['gpt-6-astra','deepseek-flash']),'deepseek-flash');
 assert.equal(preferredSideModel(['gpt-6-astra','gemini-3-flash']),'gemini-3-flash');
 assert.equal(preferredSideModel(['gpt-6-astra']),'gpt-6-astra');
 assert.equal(preferredSideModel([]),null);
});

test('side answers: the live state is a bounded, read-only copy (FEATURE-SPECS 2.4)',()=>{
 const turn={id:'t1',chatId:'c',prompt:'build it',text:'x'.repeat(5000),status:'running',activity:'Running 1 tool',model:'gpt-6-astra',created:0} as Turn;
 const job={id:'j1',chatId:'cj',prompt:'build it',text:'job text',status:'running',model:'deepseek-flash',created:0} as Turn;
 const tools=[...Array.from({length:40},(_,n)=>({id:'a'+n,turnId:'t1',name:'read_file',args:{path:'src/'+n+'.ts'},result:'r'.repeat(500),status:'completed'})),
  {id:'p',turnId:'t1',name:'todo_list',args:{todos:[{content:'Fix the menu',status:'in_progress'}]},result:null,status:'completed'},
  {id:'j',turnId:'j1',name:'patch',args:{path:'src/job.ts'},result:'ok',status:'completed'},
  {id:'other',turnId:'elsewhere',name:'patch',args:{path:'secret.ts'},result:'ok',status:'completed'}] as ToolCall[];
 const live=sideState({turn,jobs:[job],tools,queued:[{prompt:'and then deploy'} as Turn],recent:[{prompt:'earlier ask',text:'earlier answer'} as Turn],now:150000});
 assert.equal(live.status,'running · Running 1 tool');assert.equal(live.minutesRunning,2.5);
 assert.equal(live.actions.length,30,'the last 30 actions');assert.ok(live.actions.every(action=>action.result.length<=201),'short results');
 assert.match(String(live.plan),/Fix the menu/);
 assert.ok(live.filesTouched.includes('src/job.ts'),'a parallel job’s files come along');assert.ok(!live.filesTouched.includes('secret.ts'),'other turns stay out');
 assert.ok(live.textSoFar.length<=3001);assert.deepEqual(live.waitingMessages,['and then deploy']);
 assert.deepEqual(live.lastMessages,[{you:'earlier ask',model:'earlier answer'}]);assert.equal(live.jobs[0].model,'deepseek-flash');
});
