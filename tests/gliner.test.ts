import test from 'node:test';
import assert from 'node:assert/strict';
import {glinerLabels,ownPicks,parseGliner} from '../app/gliner';
import type {JevState} from '../app/jev';

const settings={summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:10000};
const state:JevState={summary:'Write the release notes',current:null,selected:[],models:[{id:'a',label:'DeepSeek',available:true,capabilities:['text','coding']},{id:'b',label:'GPT',available:true,capabilities:['text']},{id:'c',label:'GPT',available:true,capabilities:['text','image']},{id:'d',label:'Off',available:false,capabilities:['text']}],health:[],attachmentTypes:[]};

test('GLiNER labels map back to models, unsure stays a question, bad answers are refused',()=>{
 const labels=glinerLabels(state);
 assert.deepEqual(labels.map(row=>row.label),['DeepSeek (text, coding)','GPT (text) · b','GPT (text, image) · c']);
 assert.equal(parseGliner({label:'GPT (text, image) · c',confidence:0.9},labels,settings).model,'c');
 const unsure=parseGliner({label:'DeepSeek (text, coding)',confidence:0.4},labels,settings);assert.equal(unsure.model,null);assert.match(unsure.message,/unsure/);
 for(const bad of [{label:'Off (text)',confidence:0.9},{label:'DeepSeek (text, coding)',confidence:2},{label:'DeepSeek (text, coding)'},null])assert.throws(()=>parseGliner(bad,labels,settings),/invalid decision/);
});

test('his own picks stay his: one answers, two or more answer together, unavailable ones are skipped',()=>{
 assert.equal(ownPicks(state),null);
 assert.equal(ownPicks({...state,selected:['d']}),null);
 assert.deepEqual(ownPicks({...state,selected:['b']})?.model,'b');
 const both=ownPicks({...state,selected:['a','c','d']})!;assert.equal(both.model,'a');assert.deepEqual(both.models,['a','c']);
});
