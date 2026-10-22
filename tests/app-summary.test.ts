import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appSummarySources,summaryRevision,summaryBatches,validateSummary,appSummaryError,applyTodoTitles} from '../app/app-summary';
import {Store} from '../app/store';
import {saveApp,appTodo,type AppTodo} from '../app/saved-apps';

test('AI task titles preserve original notes, invalidate after edits and ignore stale or deleted tasks',()=>{
 const store=new Store(':memory:'),app=saveApp(store,{name:'Studio'});
 try{
  const original='Build repository maps with source-backed explanations. Keep the complete original details and all constraints when starting the task.';
  const todo=appTodo(store,{app:app.id,title:original})!;
  applyTodoTitles(store,[todo],[{id:todo.id,text:'Build source-backed repository maps'}]);
  assert.equal(store.get<AppTodo>('app-todo',todo.id).title,original);
  assert.equal(store.get<AppTodo>('app-todo',todo.id).summary,'Build source-backed repository maps');
  const source=appSummarySources({...app,todos:[todo]},{chats:[],turns:[],approvals:[],goals:[]});
  const changed=appTodo(store,{app:app.id,id:todo.id,title:original+' Add keyboard controls.'})!;
  assert.equal(changed.summary,undefined);
  assert.notEqual(summaryRevision(source),summaryRevision(appSummarySources({...app,todos:[changed]},{chats:[],turns:[],approvals:[],goals:[]})));
  applyTodoTitles(store,[todo],[{id:todo.id,text:'Old title'}]);
  assert.equal(store.get<AppTodo>('app-todo',todo.id).summary,undefined);
  assert.throws(()=>applyTodoTitles(store,[changed],[{id:'unrelated',text:'Wrong task'}]),/invalid/);
  assert.throws(()=>applyTodoTitles(store,[changed],[{id:todo.id,text:'x'.repeat(97)}]),/invalid/);
  appTodo(store,{app:app.id,id:todo.id,remove:true});applyTodoTitles(store,[changed],[{id:todo.id,text:'Deleted task'}]);
  assert.equal(store.all('app-todo').length,0);
 }finally{store.db.close();}
});

test('app summary failures are concise and retain useful validation messages',()=>{
 const timeout='Auxiliary title_generation request timed out after 20s\nTraceback (most recent call last):\n'+('File "C:\\app\\runtime\\client.py"\n'.repeat(300));
 assert.match(appSummaryError(timeout),/took too long/);assert.ok(appSummaryError(timeout).length<180);assert.doesNotMatch(appSummaryError(timeout),/Traceback|client.py/);
 assert.match(appSummaryError('Traceback\nValueError: bad response'),/Could not update/);
 assert.equal(appSummaryError(Error('The app summary included a finding without matching source evidence.')),'The app summary included a finding without matching source evidence.');
 assert.equal(appSummaryError(timeout,true),'Summary stopped.');
});

test('summary coverage includes full long messages and nested jobs, changes revision and requires matching evidence',()=>{
 const app={name:'Studio',stage:'',current:'',ideas:'',planned:'',chatIds:['one']} as any;
 const state={chats:[{id:'one',title:'Studio'}],turns:[{id:'turn',chatId:'one',created:1,status:'completed',prompt:'x'.repeat(19000)+'END',text:'Build remains open.'},{id:'job',chatId:'child',parentTurnId:'turn',created:2,status:'completed',prompt:'Check it',text:'Question: which host?'},{id:'private',chatId:'unrelated',created:1,prompt:'PRIVATE'}],approvals:[],goals:[]} as any;
 const sources=appSummarySources(app,state);assert.ok(sources.some(s=>s.text.endsWith('END')));assert.ok(sources.some(s=>s.id.startsWith('job:')&&s.chatId==='one'));assert.ok(!sources.some(s=>s.text.includes('PRIVATE')));
 const revision=summaryRevision(sources);state.turns[0].text='Resolved now.';assert.notEqual(summaryRevision(appSummarySources(app,state)),revision);
 const source=sources.find(s=>s.id.startsWith('job:reply'))!;
 const good={kind:'question',text:'Choose a hosting provider.',evidence:[{sourceId:source.id,quote:'which host?'}]};assert.equal(validateSummary([good],sources).length,1);
 assert.throws(()=>validateSummary([{...good,evidence:[{sourceId:'unrelated',quote:'which host?'}]}],sources));assert.throws(()=>validateSummary([{...good,evidence:[{sourceId:source.id,quote:'Invented evidence'}]}],sources));
 assert.deepEqual(summaryBatches(sources).flat(),sources);assert.ok(summaryBatches([...sources,...sources,...sources]).length>1);
});
