import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../app/store';import {pickerTokens} from '../app/pickers';

test('retiring LAYA migrates its settings while preserving chat selectors and historic usage',()=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tris-picker-retirement-')),file=path.join(folder,'chat.sqlite');
 let store=new Store(file);
 try{
  store.put('settings',{id:'decision-engine',engine:'laya'});store.put('settings',{id:'laya',summaryModel:'deepseek-flash'});
  const chat={id:'chat',selector:'deepseek-flash',pool:['deepseek-flash']},turn={id:'turn',routingUsage:{engine:'laya',layaTokens:42}};
  store.put('chat',chat);store.put('turn',turn);store.db.close();store=new Store(file);
  assert.equal(store.get<any>('settings','decision-engine').engine,'jev');assert.throws(()=>store.get('settings','laya'),/not found/);
  assert.deepEqual(store.get('chat','chat'),chat);assert.deepEqual(store.get('turn','turn'),turn);assert.equal(pickerTokens(store.get<any>('turn','turn').routingUsage),42);
  store.put('settings',{id:'decision-engine',engine:'gliner'});store.db.close();store=new Store(file);assert.equal(store.get<any>('settings','decision-engine').engine,'gliner');
 }finally{store.db.close();fs.unlinkSync(file);fs.rmdirSync(folder);}
});
