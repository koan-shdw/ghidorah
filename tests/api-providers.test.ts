import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {apiModel} from '../app/api-catalog';
import {providerFor,wireModel,appModel} from '../app/models';
import {Store} from '../app/store';
import {AccountHealth,blockedFor} from '../app/availability';
import {providerAccess} from '../app/provider-access';

test('renewed OAuth bearer retries without reviving rejected credentials or credit',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tris-refresh-')),store=new Store(path.join(directory,'chat.sqlite')),health=new AccountHealth(store),owner=await providerAccess(health,()=>{});
 const request=async(body:any)=>await (await fetch(owner.connection.url,{method:'POST',headers:{Authorization:'Bearer '+owner.connection.token},body:JSON.stringify({provider:'nous',model:'test',...body})})).json();
 const old='a'.repeat(64),fresh='b'.repeat(64);
 try{
  await request({phase:'response',credential:old,surface:{provider:'nous',model:'test',code:'auth',layer:'auth'}});
  assert.equal((await request({phase:'request',credential:old})).blocked,true);
  assert.equal((await request({phase:'request',credential:fresh})).blocked,false);
  assert.equal((await request({phase:'request',credential:old})).blocked,true);
  health.observe('nous','billing','limit',true);
  assert.equal((await request({phase:'request',credential:fresh})).reason,'limit');
  health.clear('nous',['billing'],Date.now());health.observe('nous','auth','auth',true,Date.now()+1000);
  assert.equal((await request({phase:'request',credential:fresh})).reason,'auth');
  health.clear('nous',['auth'],Date.now()+2000);
  assert.equal((await request({phase:'request',credential:old})).blocked,false,'A later successful account check restores a valid unchanged credential');
 }finally{owner.close();store.db.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('model identity keeps supplier ownership across catalogues, transport and health',async()=>{
 const id=apiModel('gemini','gemini-3.8-flash');assert.equal(providerFor(id),'gemini');assert.equal(wireModel(id),'gemini-3.8-flash');assert.equal(appModel('gemini',wireModel(id)),id);
 assert.throws(()=>apiModel('unknown','model'));assert.throws(()=>apiModel('gemini','model --provider xai'));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tris-api-health-')),store=new Store(path.join(directory,'chat.sqlite')),health=new AccountHealth(store),owner=await providerAccess(health,()=>{});
 const request=(body:any)=>fetch(owner.connection.url,{method:'POST',headers:{Authorization:'Bearer '+owner.connection.token},body:JSON.stringify(body)});
 try{
  assert.equal((await request({provider:'gemini',model:wireModel(id),phase:'request'})).status,200);
  await request({provider:'gemini',model:wireModel(id),phase:'response',surface:{provider:'gemini',model:wireModel(id),code:'model_not_found',layer:'provider'}});
  assert.ok(blockedFor(health.rows(),id));assert.equal(blockedFor(health.rows(),apiModel('xai',wireModel(id))),undefined);
  assert.equal((await (await request({provider:'gemini',model:wireModel(id),phase:'request'})).json()).blocked,true);
  assert.equal((await request({provider:'unknown',model:'test',phase:'request'})).status,400);
 }finally{owner.close();store.db.close();fs.rmSync(directory,{recursive:true,force:true});}
});
