import test from 'node:test';
import assert from 'node:assert/strict';
import {pickers,isPicker,picker,pickerTokens} from '../app/pickers';
import {parseJev,type JevState} from '../app/jev';

// One shared routing state; each picker reads the same questions and answers in its own shape (5.9).
const state:JevState={summary:'Fix the failing build',current:'a',selected:[],models:['a','b'].map(id=>({id,label:id,available:true,capabilities:['text','coding']})),health:[],attachmentTypes:[]};
const settings={summaryModel:'deepseek-flash',confidence:0.7,timeoutMs:500};

test('the picker list: five pickers, one record each',()=>{
 assert.deepEqual(pickers.map(row=>row.id),['jev','kev','glide','gliner','notdiamond']);
 assert.equal(new Set(pickers.map(row=>row.short)).size,5);
 assert.ok(pickers.every(row=>row.timeoutMs>=500&&row.timeoutMs<=300000));assert.equal(picker('glide')?.timeoutMs,300000);
 assert.equal(isPicker('laya'),false);assert.equal(isPicker('kev'),true);assert.equal(isPicker('selector'),false);assert.equal(isPicker('constructor'),false);
 assert.equal(picker('glide')?.connects,'key');
});

test('Jev answers the routing state; old turns keep their own token counts',()=>{
 const jev=parseJev({answers:{primary:{type:'choice',choice:'b',confidence:0.9},execution:{type:'choice',choice:'single',confidence:0.9},after_1:{type:'choice',choice:'a',confidence:0.9}},usage:{input_tokens:3,output_tokens:1}},state,settings);
 assert.equal(jev.model,'b');assert.deepEqual(jev.order,['b','a']);
 assert.equal(pickerTokens({pickerTokens:12,jevTokens:3}),12);assert.equal(pickerTokens({jevTokens:3}),3);assert.equal(pickerTokens({layaTokens:5}),5);assert.equal(pickerTokens(undefined),undefined);
});
