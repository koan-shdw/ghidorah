import test from 'node:test';
import assert from 'node:assert/strict';
import {outcomes,learningState,readSummary} from '../app/learning';
import type {Turn} from '../app/types';

const turn=(id:string,created:number,model:string,extra:Partial<Turn>={}):Turn=>({id,chatId:'c',prompt:id,attachments:[],text:'',reasoning:'',status:'completed',model,error:null,usage:{turn_cost_usd:0.01},created,finished:created+2000,routingUsage:{engine:'jev',summaryModel:'deepseek-flash',summaryTokens:10},...extra} as any);

test('outcomes: Stop, a correcting reply, a changed pick and praise, worst signal first',()=>{
 const turns=[turn('a',1000,'gpt'),turn('b',2000,'gpt'),turn('c',3000,'deepseek',{requestedModels:['deepseek']}),turn('d',4000,'gpt',{status:'stopped'}),turn('e',5000,'gpt'),turn('f',6000,'gpt',{routingUsage:{engine:'selector',summaryModel:'x',summaryTokens:1}}),turn('g',7000,'gpt',{status:'running'})];
 const rows=[{id:'a',chatId:'c',kind:'coding',reaction:'correction' as const},{id:'b',chatId:'c',kind:'coding'},{id:'e',chatId:'c',kind:'coding',reaction:'praise' as const}];
 const result=outcomes(turns,rows,[{chatId:'c',model:'deepseek',created:2500,selected:true},{chatId:'c',model:'gpt',created:5500,selected:false}]);
 assert.deepEqual(result.map(row=>[row.turn.id,row.kind,row.outcome]),[['a','coding','corrected'],['b','coding','overridden'],['c','general','accepted'],['d','general','stopped'],['e','coding','praised'],['f','general','accepted']]);
});

test('learning state: same kind only, acceptance, speed and cost per model, and it always fits its limit',()=>{
 const turns=Array.from({length:30},(_,index)=>turn('t'+index,1000*(index+1),index%3?'gpt':'deepseek'));
 const rows=turns.map((row,index)=>({id:row.id,chatId:'c',kind:index%2?'coding':'writing',...(index===29?{reaction:'correction' as const}:{})}));
 const state=learningState(outcomes(turns,rows,[]),'coding');
 assert.equal(state.kind,'coding');assert.equal(state.recent.length,8);assert.deepEqual(state.recent.at(-1),{model:'gpt',outcome:'corrected'});
 const gpt=state.models.find(row=>row.model==='gpt')!;assert.equal(gpt.turns,10);assert.equal(gpt.accepted,9);assert.equal(gpt.seconds,2);assert.equal(gpt.cost,0.01);
 const tight=learningState(outcomes(turns,rows,[]),'coding',8,120);assert.ok(JSON.stringify(tight).length<=120);
 assert.deepEqual(learningState([],'coding'),{kind:'coding',recent:[],models:[]});
});

test('the summary\'s two closing lines are read and removed',()=>{
 assert.deepEqual(readSummary('Fix the login form.\nTask kind: Coding\nPrevious reply: correction'),{summary:'Fix the login form.',kind:'coding',reaction:'correction'});
 assert.deepEqual(readSummary('Plain summary.'),{summary:'Plain summary.',kind:'general',reaction:'neutral'});
 assert.equal(readSummary('x\nPrevious reply: maybe').reaction,'neutral');
});

test('failed and interrupted turns never count as accepted; selector outcomes remain available',()=>{
 const failed=turn('failed',1000,'a',{status:'failed'}),interrupted=turn('interrupted',2000,'a',{status:'interrupted'}),selected=turn('selected',3000,'b',{routingUsage:{engine:'selector',summaryModel:'b',summaryTokens:1}});
 const result=outcomes([failed,interrupted,selected],[],[]);
 assert.deepEqual(result.map(row=>row.outcome),['failed','interrupted','accepted']);
 assert.equal(learningState(result,'general').models.find(row=>row.model==='a')!.accepted,0);
 assert.equal(learningState(result).recent.length,3,'selectors receive history across known task kinds');
});
