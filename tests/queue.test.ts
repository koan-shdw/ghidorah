import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {Store} from '../app/store';
import type {Turn} from '../app/types';
import {mainSource} from './fixtures/main-source';

const source=mainSource();
const waitingRow=(store:Store)=>{const node=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='waitingRow')!;return new Function('store',ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return waitingRow;')(store);};

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
