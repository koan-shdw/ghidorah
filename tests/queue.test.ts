import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {providerFor} from '../app/models';
import {Store} from '../app/store';
import type {Turn} from '../app/types';
import {mainSource} from './fixtures/main-source';

const source=mainSource();
const waitingRow=(store:Store)=>{const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='waitingRow')!;return new Function('store',ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return waitingRow;')(store);};
// One function from the main source, with the names it reads given by the test.
const fromMain=(name:string,env:Record<string,unknown>,consts:string[]=[])=>{
  const text=[...consts.map(c=>source.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(source)===c))!),source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)!].map(n=>n.getText(source)).join('\n');
  return new Function(...Object.keys(env),ts.transpile(text,{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(env));
};

test('after a restart queued messages are paused: never sent by themselves, never blocking, sent by one click (Koan 2026-10-08)',()=>{
  const store=new Store(':memory:'),chat=store.chat(store.project().id),old=store.accept('old',chat.id,'From before the restart');
  store.interrupt();const paused=store.get<Turn>('turn',old.id);assert.equal(paused.status,'queued');assert.equal(paused.paused,true);
  const next=waitingRow(store);
  assert.equal(next(chat.id),undefined,'not sent automatically');
  const fresh=store.accept('new',chat.id,'Typed after the restart');
  assert.equal(next(chat.id)?.id,fresh.id,'a new message is not blocked by the paused one');
  store.update<Turn>('turn',fresh.id,{status:'needs-model'});assert.equal(next(chat.id)?.status,'needs-model','a message waiting for a model choice keeps its place');
  store.db.close();
});

// 10-26: after a restart a message held its chat at "Choose a model"; the three typed after it showed "Sending".
test('messages behind one waiting for a model choice say so, and the text goes once it has its model',()=>{
  const store=new Store(':memory:'),chat=store.chat(store.project().id);
  const head=store.accept('head',chat.id,'first'),b=store.accept('b',chat.id,'second'),c=store.accept('c',chat.id,'third'),paused=store.accept('d',chat.id,'paused');
  store.update<Turn>('turn',head.id,{status:'needs-model'});store.update<Turn>('turn',paused.id,{paused:true});
  const nameBehind=fromMain('nameBehind',{store,emit:()=>{}},['BEHIND']),rows=()=>store.where<Turn>('turn','chatId',chat.id),hold=(id:string)=>store.get<Turn>('turn',id).hold;
  nameBehind(rows(),store.get<Turn>('turn',head.id));
  assert.equal(hold(b.id),'Waiting for a model for the message above');assert.equal(hold(c.id),'Waiting for a model for the message above');
  assert.equal(hold(paused.id),undefined,'a paused message keeps its own text');
  store.update<Turn>('turn',head.id,{status:'queued'});store.update<Turn>('turn',c.id,{hold:'Waiting for the backend to start'});
  nameBehind(rows(),store.get<Turn>('turn',head.id));
  assert.equal(hold(b.id),undefined,'the text goes once the first message has its model');
  assert.equal(hold(c.id),'Waiting for the backend to start','other waits are left alone');
  store.db.close();
});

// 10-26: a message sent 84 s after a restart was routed before Claude Code's check listed its models: Jev's summary
// model (Claude Sonnet) and the chat's last model (Claude Opus) were missing, so it went to "Choose a model".
test('during Claude Code\'s first check a message to be routed waits for it when routing leans on a Claude model',()=>{
  const store=new Store(':memory:'),chat=store.chat(store.project().id),turn={...store.accept('t',chat.id,'generate an image'),routePending:true} as Turn;
  let summaryModel='claude-code:sonnet',ready=['gpt-6-astra'],first=true;
  const wait=(row:Turn=turn)=>fromMain('claudeRouteWait',{claudeFirstCheck:first,store,classifierActive:()=>true,decisionEngine:()=>'jev',pickerSettings:()=>({summaryModel}),providerFor,availableModels:()=>ready})(chat,row);
  assert.equal(wait(),'Waiting for Claude Code to connect','Jev summarises with Claude Sonnet, not listed yet');
  ready=['gpt-6-astra','claude-code:sonnet'];assert.equal(wait(),'','Claude Sonnet listed: no wait');
  ready=['gpt-6-astra'];first=false;assert.equal(wait(),'','after the first check routing goes on as before');
  first=true;assert.equal(wait({...turn,routePending:false}),'','a message with its own model waits as before, by its model');
  summaryModel='deepseek-flash';assert.equal(wait(),'','nothing from Claude to wait for');
  const done=store.accept('done',chat.id,'earlier','claude-code:opus');store.update<Turn>('turn',done.id,{status:'completed',created:turn.created-1});
  assert.equal(wait(),'Waiting for Claude Code to connect','the chat\'s last model is Claude Opus');
  store.update<Turn>('turn',done.id,{status:'failed'});store.put('settings',{id:'last-model',model:'claude-code:opus'});
  assert.equal(wait(),'Waiting for Claude Code to connect','the app\'s last model is Claude Opus');
  store.db.close();
});
