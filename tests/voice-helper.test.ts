import test from 'node:test';
import assert from 'node:assert/strict';
import {helperAnswer,contextPages} from '../app/voice-helper';

test('helper replies only propose text or request known context; they cannot authorize actions',()=>{
 const draft={reply:'I have the message ready.',draft:'Fix the calculation.',chatId:null,readPage:null};assert.deepEqual(helperAnswer(JSON.stringify(draft),['chat-a'],2),draft);
 for(const patch of [{send:true},{approved:true},{chatId:'unknown'},{draft:''},{readPage:2},{readPage:-1},{readPage:.5},{reply:null},{readPage:0}])assert.throws(()=>helperAnswer(JSON.stringify({...draft,...patch}),['chat-a'],2));
 assert.deepEqual(helperAnswer('{"reply":"","draft":null,"chatId":null,"readPage":0}',['chat-a'],2),{reply:'',draft:null,chatId:null,readPage:0});
 const history='a'.repeat(999)+'🌍'+('full chat\n'.repeat(10000)),pages=contextPages(history,1000);assert.equal(pages.join(''),history);assert.ok(pages.every(page=>!/\ud800$|\ud83c$/.test(page)));
});
