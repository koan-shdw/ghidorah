import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store';
import {saveApp,removeApp} from '../app/saved-apps';
import {defaultWatch,readWatch,readIdeas,ideasPrompt,nextWatchRun,updateModel,type AppIdea} from '../app/app-watch';

test('update models use connected defaults and never silently replace a saved model',()=>{
 const models=['claude-code:opus','deepseek-flash'];
 assert.equal(updateModel('',models,'disconnected'),'claude-code:opus');
 assert.equal(updateModel('',models,'deepseek-flash'),'deepseek-flash');
 assert.equal(updateModel('claude-code:opus',models),'claude-code:opus');
 assert.equal(updateModel('disconnected',models),'');
 assert.equal(updateModel('',[],'deepseek-flash'),'');
});

test('watch settings validate input and schedule only when on',()=>{
 const now=new Date(2026,9,8,12,0).getTime(),off=readWatch({topics:' - vid2vid ',sources:'YouTube: Fireship'},defaultWatch('a'),now);
 assert.equal(off.topics,'- vid2vid');assert.equal(off.nextRun,null);
 const daily=readWatch({frequency:'daily'},off,now);assert.equal(daily.nextRun,new Date(2026,9,9,9,0).getTime());assert.equal(daily.sources,'YouTube: Fireship');
 assert.equal(readWatch({topics:'more'},daily,now+5).nextRun,daily.nextRun,'Editing topics keeps the schedule');
 assert.equal(new Date(nextWatchRun('weekly',now)!).getDay(),1);
 assert.throws(()=>readWatch({frequency:'hourly'},off,now));assert.throws(()=>readWatch({topics:'x'.repeat(2001)},off,now));
 assert.equal(readWatch({sources:'x'.repeat(4000)},off,now).sources.length,4000);assert.throws(()=>readWatch({sources:'x'.repeat(4001)},off,now));
});
test('ideas must cite fetched items and be new to the app',()=>{
 const items=[{id:'s1',url:'https://a.example/1',title:'Model X',excerpt:'',source:'Search'},{id:'s2',url:'https://b.example/2',title:'Old',excerpt:'',source:'r/x',published:5}];
 const existing=[{title:'Already suggested',sources:[{url:'https://b.example/2',title:'Old'}]}] as AppIdea[];
 const ideas=readIdeas([
  {title:'Use Model X',summary:'New model.',why:'Faster renders.',change:'Add a Model X backend.',effort:'small',sources:['s1']},
  {title:'Invented',summary:'No source.',change:'Something.',sources:['s9']},
  {title:'Already suggested!',summary:'Repeat.',change:'Again.',sources:['s1']},
  {title:'Reported link',summary:'Same link.',change:'Again.',sources:['s2']},
  {title:'use model x',summary:'Duplicate title.',change:'Again.',sources:['s1']},
 ],items,existing,'app',10);
 assert.deepEqual(ideas.map(idea=>idea.title),['Use Model X']);
 assert.deepEqual(ideas[0].sources,[{url:'https://a.example/1',title:'Model X'}]);assert.equal(ideas[0].status,'new');assert.equal(ideas[0].found,10);
 assert.equal(readIdeas([{title:'T',summary:'S',change:'C',effort:'huge',sources:['s1']}],items,[],'app',1)[0].effort,'medium');
 assert.throws(()=>readIdeas('nope',items,[],'app',1));
});
test('the opening message lists each selected update with a brief, and app removal clears the watch',()=>{
 const idea={title:'Use Model X',effort:'small',summary:'New model.',why:'Faster.',change:'Add a backend.',sources:[{url:'https://a.example/1',title:''}]} as AppIdea;
 const prompt=ideasPrompt({name:'Video Dancer',repositories:['I:/DEV/video-dancer']},[idea,{...idea,title:'Second'}]);
 assert.match(prompt,/Wait for my GO/);assert.match(prompt,/I:\/DEV\/video-dancer/);assert.match(prompt,/1\. Use Model X \(small effort\)[\s\S]*Suggested update: Add a backend\.[\s\S]*2\. Second/);
 const store=new Store(':memory:'),app=saveApp(store,{name:'Video Dancer'}),other=saveApp(store,{name:'Other'});
 store.put('app-watch',defaultWatch(app.id));store.put('app-idea',{...idea,id:'i1',appId:app.id});store.put('app-idea',{...idea,id:'i2',appId:other.id});
 removeApp(store,app.id);assert.equal(store.all('app-watch').length,0);assert.deepEqual(store.all<any>('app-idea').map(row=>row.id),['i2']);store.db.close();
});
