import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeModelList} from '../app/claude';

const row=(value:string,label:string)=>({id:'claude-code:'+value,label});
// Seen in the app on 2026-10-28: Claude Code's list before it loaded the account's models.
const short=[row('claude-haiku-4-5','Haiku 4.5'),row('default','Default (recommended)'),row('opus','Opus'),row('sonnet','Sonnet'),row('haiku','Haiku')];
const full=[row('default','Default (recommended)'),row('opus','Opus 5.5'),row('fable','Fable 5.1'),row('sonnet','Sonnet 5.5'),row('haiku','Haiku 5.5')];

test('a short startup list does not replace the full Claude model list',()=>{
  assert.deepEqual(claudeModelList(short,full),{models:full,short:true});
  assert.deepEqual(claudeModelList(short,undefined),{models:short,short:true});
  assert.deepEqual(claudeModelList(short,short),{models:short,short:true});
  assert.deepEqual(claudeModelList(full,short),{models:full,short:false});
  assert.deepEqual(claudeModelList([row('haiku','Haiku fixture')],full),{models:[row('haiku','Haiku fixture')],short:false});
});
