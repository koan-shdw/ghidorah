import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {applyTurnStream} from '../app/turn-stream';
import type {Snapshot,Turn} from '../app/types';
import {mainSource} from './fixtures/main-source';

test('stream updates preserve history and final replies, and never add an unrelated turn',()=>{
 const finished={id:'finished',status:'completed',text:'Final answer'},running={id:'live',status:'running',text:'Before'},tools=[{result:'large history'}];
 const state={turns:[finished,running],tools} as unknown as Snapshot;
 const updated=applyTurnStream(state,[{id:'live',text:'After',reasoning:''},{id:'finished',text:'Stale',reasoning:''},{id:'foreign',text:'Private',reasoning:''}]);
 assert.equal(updated.tools,tools);assert.equal(updated.turns[0],finished);assert.equal(updated.turns.length,2);assert.equal(updated.turns[1].text,'After');assert.equal(running.text,'Before');
});

test('stream transport coalesces updates and sends only turns already visible in each window',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const source=mainSource();
 const code=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='emitStream')!.getText(source);
 const sent:any[]=[];const window=(id:string)=>({isDestroyed:()=>false,webContents:{send:(channel:string,rows:unknown)=>sent.push({id,channel,rows})}}),main=window('main'),child=window('child'),unrelated=window('other');
 const rows=new Map<string,Partial<Turn>>([['one',{id:'one',status:'running',text:'First',reasoning:''}],['two',{id:'two',status:'running',text:'Second',reasoning:''}]]);
 const environment={store:{get:(_:string,id:string)=>rows.get(id)},BrowserWindow:{getAllWindows:()=>[main,child,unrelated]},streamWindows:new WeakMap([[main,new Set(['one','two'])],[child,new Set(['one'])]]),streamTurns:new Set(),closingWindows:new Set(),setTimeout};
 const emit=new Function(...Object.keys(environment),'let streamTimer;'+ts.transpile(code,{target:ts.ScriptTarget.ES2022})+';return emitStream;')(...Object.values(environment));
 emit('one');emit('one');emit('two');rows.get('one')!.text='Latest';t.mock.timers.tick(50);
 const first={id:'one',text:'Latest',reasoning:'',activity:undefined,stageSince:undefined,lastActivity:undefined},second={...first,id:'two',text:'Second'};
 assert.deepEqual(sent,[{id:'main',channel:'turn-stream',rows:[first,second]},{id:'child',channel:'turn-stream',rows:[first]}]);
 sent.length=0;emit('one');rows.get('one')!.status='completed';t.mock.timers.tick(50);assert.equal(sent.length,0);
});
