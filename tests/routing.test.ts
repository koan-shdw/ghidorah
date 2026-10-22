import {test} from 'node:test';
import assert from 'node:assert/strict';
import {route} from '../app/routing';
test('no-key Jev path respects explicit choice and uses only a prior eligible model identity',async()=>{
 assert.deepEqual(await route({selected:['deepseek-flash'],eligible:['deepseek-flash'],previous:null}),{model:'deepseek-flash',reason:'selected'});
 assert.deepEqual(await route({selected:[],eligible:['deepseek-flash'],previous:'deepseek-flash'}),{model:'deepseek-flash',reason:'previous'});
 await assert.rejects(route({selected:[],eligible:['deepseek-flash'],previous:null}));
 await assert.rejects(route({selected:['unavailable'],eligible:['deepseek-flash'],previous:'deepseek-flash'}));
 assert.equal((await route({selected:['deepseek-flash'],eligible:['deepseek-flash'],previous:null},async()=>{throw Error('Jev unavailable');})).model,'deepseek-flash');
 assert.deepEqual(await route({selected:[],eligible:['gpt-6-astra'],previous:'deepseek-flash',appPrevious:'gpt-6-astra'}),{model:'gpt-6-astra',reason:'app-previous'});
 await assert.rejects(route({selected:['deepseek-flash'],eligible:['gpt-6-astra'],previous:null,appPrevious:'gpt-6-astra'}),'An unavailable explicit choice must ask, not silently use the app fallback');
 assert.deepEqual((await route({selected:['a','b'],eligible:['a','b'],previous:'a'})).models,['a','b']);
 let calls=0;const picker=async()=>{calls++;return 'b';};
 assert.equal((await route({selected:['a'],eligible:['a','b'],previous:'b'},picker)).model,'a');
 await assert.rejects(route({selected:['missing'],eligible:['a','b'],previous:'b'},picker));assert.equal(calls,0);
 assert.equal((await route({selected:[],eligible:['a','b'],previous:'a'},picker)).model,'b');assert.equal(calls,1);
 await assert.rejects(route({selected:['a','b'],eligible:['a'],previous:'a'}));
});
