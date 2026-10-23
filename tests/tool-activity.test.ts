import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {activityInfo,ToolActivity,editLines,resultText,took} from '../app/tool-activity';
import {ChatViewContext} from '../app/chat-view';
import type {ToolCall} from '../app/types';
const tool=(values:Partial<ToolCall>={}):ToolCall=>({id:'edit',turnId:'original-turn',name:'patch',args:{path:'app/file.ts'},result:{success:true,diff:'--- app/file.ts\n+++ app/file.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+++ payload'},status:'completed',...values});

test('activity reports actual results, returned diff counts, and native/MCP tool kinds',()=>{
 const edit=activityInfo(tool());assert.equal(edit.kind,'edit');assert.deepEqual(edit.counts,{added:2,removed:1});assert.deepEqual(edit.files,['app/file.ts']);
 for(const result of [{success:false,error:'Patch did not match'},{content:[{type:'text',text:'{"error":"Approval expired"}'}],isError:true},'Error: Action blocked']){
  const failed=activityInfo(tool({result}));assert.equal(failed.state,'failed');assert.equal(failed.words,'Edit file.ts');assert.equal(failed.counts,null);
 }
 assert.equal(activityInfo(tool({status:'uncertain'})).state,'uncertain');
 assert.equal(activityInfo(tool({name:'terminal',result:{exit_code:1}})).state,'failed');
 assert.equal(activityInfo(tool({name:'Read',result:'The source contains Error: as a string'})).state,'completed');
 assert.equal(activityInfo(tool({name:'mcp__ghidorah__search_web'})).kind,'web');
 assert.equal(activityInfo(tool({name:'read_web_page',args:{url:'https://example.com/a'}})).words,'Open example.com');
 assert.equal(activityInfo(tool({name:'Grep'})).kind,'search');
 assert.equal(activityInfo(tool({name:'MultiEdit'})).kind,'edit');
 assert.equal(activityInfo(tool({name:'Write',args:{path:'new.ts',content:'one\ntwo'},result:'File saved'})).counts,null);
 assert.deepEqual(activityInfo(tool({result:{success:true,files_modified:['I:/DEV/app/file.ts']}})).files,['I:/DEV/app/file.ts']);
 assert.doesNotThrow(()=>activityInfo(tool({args:'unfinished json'})));
});

test('A2: rows in plain words, internal steps hidden, a closed line that names the current action (Koan 2026-10-10)',()=>{
 assert.equal(activityInfo(tool({name:'Bash',args:{command:'git status --short',description:'Check what changed'}})).words,'Check what changed');
 assert.equal(activityInfo(tool({name:'terminal',args:{command:'node scripts/unit-tests.mjs'}})).words,'Run node scripts/unit-tests.mjs');
 assert.equal(activityInfo(tool({name:'Read',args:{file_path:'I:\\DEV\\app\\store.ts'}})).words,'Read store.ts');
 assert.equal(activityInfo(tool({name:'Grep',args:{pattern:'shouldAutoCompact'}})).words,'Search for "shouldAutoCompact"');
 assert.equal(activityInfo(tool({name:'Write',args:{file_path:'a/new.ts',content:'x'}})).words,'Write new.ts');
 assert.ok(activityInfo(tool({name:'mcp__ghidorah__inspect_action'})).internal);assert.ok(!activityInfo(tool({name:'Read'})).internal);
 assert.equal(took(tool({started:1000,finished:2234})),'1.2 s');assert.equal(took(tool({started:0,finished:72000})),'1 min 12 s');assert.equal(took(tool()),'');
 assert.deepEqual(editLines({old_string:'a',new_string:'b\nc'},null)?.map(l=>l.sign+l.text),['-a','+b','+c']);
 assert.deepEqual(editLines({},{diff:'--- f\n+++ f\n@@ -1 +1 @@\n-old\n+new'})?.map(l=>l.sign+l.text),['-old','+new']);
 assert.equal(resultText({output:'done',exit_code:0}),'done');assert.equal(resultText({content:[{type:'text',text:'hi'}]}),'hi');

 const tools=[tool(),tool({id:'cmd',name:'terminal',args:{command:'node --version'},result:'v24',status:'running'}),tool({id:'failed',result:{success:false,error:'No files modified'}}),tool({id:'check',name:'inspect_action',status:'completed',result:'ok'})];
 const normal=renderToStaticMarkup(React.createElement(ToolActivity,{tools}));
 assert.match(normal,/class="activity-group" aria-label="Tool activity"/);assert.doesNotMatch(normal,/open=""/);
 assert.match(normal,/Run node --version/);assert.match(normal,/· 3 actions/,'the internal check is not counted');assert.match(normal,/· 1 failed/);
 assert.doesNotMatch(normal,/activity-group-body|No files modified|Finished/,'closed: no rows mounted, never "Finished"');
 const done=renderToStaticMarkup(React.createElement(ToolActivity,{tools:[tool(),tool({id:'cmd2',name:'Bash',args:{command:'ls',description:'List files'},result:'a',status:'completed'})]}));
 assert.match(done,/Ran 2 actions/);assert.doesNotMatch(done,/failed/);
 const verbose=renderToStaticMarkup(React.createElement(ChatViewContext.Provider,{value:'verbose'},React.createElement(ToolActivity,{tools})));
 assert.match(verbose,/aria-label="Open app\/file.ts"/);assert.match(verbose,/2 lines added, 1 lines removed/);
 assert.match(verbose,/node --version/);assert.match(verbose,/No files modified/);assert.match(verbose,/data-status="failed"/);
 assert.match(verbose,/class="old"><i aria-hidden="true">−<\/i>old/);assert.doesNotMatch(verbose,/inspect_action/);
 assert.equal((verbose.match(/open=""/g)||[]).length,4);
 assert.equal(renderToStaticMarkup(React.createElement(ToolActivity,{tools:[]})),'');
 assert.equal(renderToStaticMarkup(React.createElement(ToolActivity,{tools:[tools[3]]})),'','only internal steps: nothing to show');
 const escaped=renderToStaticMarkup(React.createElement(ChatViewContext.Provider,{value:'verbose'},React.createElement(ToolActivity,{tools:[tool({args:{path:'<script>.ts'},result:'<script>attack</script>'})]})));
 assert.doesNotMatch(escaped,/<script>/);assert.match(escaped,/&lt;script&gt;/);
});
