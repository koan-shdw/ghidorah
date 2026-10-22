import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {activityInfo,ToolActivity} from '../app/tool-activity';
import {ChatViewContext} from '../app/chat-view';
import type {ToolCall} from '../app/types';
const tool=(values:Partial<ToolCall>={}):ToolCall=>({id:'edit',turnId:'original-turn',name:'patch',args:{path:'app/file.ts'},result:{success:true,diff:'--- app/file.ts\n+++ app/file.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+++ payload'},status:'completed',...values});

test('activity reports actual results, returned diff counts, and native/MCP tool kinds',()=>{
 const edit=activityInfo(tool());assert.equal(edit.kind,'edit');assert.deepEqual(edit.counts,{added:2,removed:1});assert.deepEqual(edit.files,['app/file.ts']);
 for(const result of [{success:false,error:'Patch did not match'},{content:[{type:'text',text:'{"error":"Approval expired"}'}],isError:true},'Error: Action blocked']){
  const failed=activityInfo(tool({result}));assert.equal(failed.state,'failed');assert.equal(failed.label,'File edit');assert.equal(failed.counts,null);
 }
 assert.equal(activityInfo(tool({status:'uncertain'})).state,'uncertain');
 assert.equal(activityInfo(tool({name:'terminal',result:{exit_code:1}})).state,'failed');
 assert.equal(activityInfo(tool({name:'Read',result:'The source contains Error: as a string'})).state,'completed');
 assert.equal(activityInfo(tool({name:'mcp__ghidorah__search_web'})).kind,'web');
 assert.equal(activityInfo(tool({name:'read_web_page'})).label,'Opened web content');
 assert.equal(activityInfo(tool({name:'Grep'})).kind,'search');
 assert.equal(activityInfo(tool({name:'MultiEdit'})).kind,'edit');
 assert.equal(activityInfo(tool({name:'Write',args:{path:'new.ts',content:'one\ntwo'},result:'File saved'})).counts,null);
 assert.deepEqual(activityInfo(tool({result:{success:true,files_modified:['I:/DEV/app/file.ts']}})).files,['I:/DEV/app/file.ts']);
 assert.doesNotThrow(()=>activityInfo(tool({args:'unfinished json'})));
});

test('one collapsed summary retains full expandable actions, file links, issue status and verbose mode',()=>{
 const tools=[tool(),tool({id:'cmd',name:'terminal',args:{command:'node --version'},result:'v24',status:'running'}),tool({id:'failed',result:{success:false,error:'No files modified'}})];
 const normal=renderToStaticMarkup(React.createElement(ToolActivity,{tools}));
 assert.match(normal,/class="activity-group" aria-label="Tool activity"/);assert.doesNotMatch(normal,/open=""/);
 assert.match(normal,/File edits, Running commands/);assert.match(normal,/3 actions/);assert.match(normal,/1 running/);assert.match(normal,/1 issue/);
 assert.doesNotMatch(normal,/activity-group-body|No files modified|node --version/,'Closed tools do not mount their bodies');
 const verbose=renderToStaticMarkup(React.createElement(ChatViewContext.Provider,{value:'verbose'},React.createElement(ToolActivity,{tools})));
 assert.match(verbose,/aria-label="Open app\/file.ts"/);assert.match(verbose,/2 lines added, 1 lines removed/);
 assert.match(verbose,/node --version/);assert.match(verbose,/No files modified/);assert.match(verbose,/data-status="failed"/);
 assert.equal((verbose.match(/open=""/g)||[]).length,4);
 assert.equal(renderToStaticMarkup(React.createElement(ToolActivity,{tools:[]})),'');
 const escaped=renderToStaticMarkup(React.createElement(ChatViewContext.Provider,{value:'verbose'},React.createElement(ToolActivity,{tools:[tool({args:{path:'<script>.ts'},result:'<script>attack</script>'})]})));
 assert.doesNotMatch(escaped,/<script>/);assert.match(escaped,/&lt;script&gt;/);
});
