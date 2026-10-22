import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {UsagePanel} from '../app/usage-panel';
import {ContextControls} from '../app/context-dialog';
import {contextTooltip,usageModels} from '../app/usage';
import type {Chat,Snapshot,Turn} from '../app/types';

const state={availability:[],apiProviders:[],claude:{models:[]}} as unknown as Snapshot;
const chat={id:'chat',model:'gpt-6-astra'} as Chat;
const turns=[
 {model:'gpt-6-astra',created:1,usage:{context_used:62111,context_max:272000,turn_total:186046}},
 {model:'command:ponytail',created:2,usage:null},
] as Turn[];

test('opening context usage after a plugin command renders the model context',()=>{
 const html=renderToStaticMarkup(React.createElement(UsagePanel,{state,chat,turns,models:['gpt-6-astra'],call:async()=>{},refresh:async()=>{},close:()=>{}}));
 assert.match(html,/23%/);
 assert.match(html,/62,111 \/ 272,000/);
 assert.doesNotMatch(html,/Plugin · ponytail/);
});

test('context tooltip uses reported context, with separate values for each selected model',()=>{
 assert.deepEqual(usageModels(turns,['gpt-6-astra','command:ponytail','api:retired:model']),['gpt-6-astra']);
 const title=contextTooltip(turns,['gpt-6-astra','claude-code:opus']);
 assert.match(title,/23% used · 62,111 \/ 272,000 tokens/);
 assert.match(title,/Claude opus: Usage not reported yet/);
 assert.doesNotMatch(title,/186,046/);
 assert.match(contextTooltip([],[]),/Select a model/);
 assert.match(contextTooltip([{model:'gpt-6-astra',created:1,usage:{context_used:0,context_max:272000,context_estimated:true}} as Turn],['gpt-6-astra']),/≈ 0% used/);
});

test('footer exposes automatic compaction state without opening the usage panel',()=>{
 const render=(chat:Chat)=>renderToStaticMarkup(React.createElement(ContextControls,{chat,turns,call:async()=>{}}));
 assert.match(render(chat),/aria-label="Automatic compaction" aria-pressed="true"/);
 assert.match(render({...chat,autoCompact:false}),/aria-label="Automatic compaction" aria-pressed="false"/);
 assert.doesNotMatch(render({...chat,sideSourceId:'source'}),/Automatic compaction/);
});

test('auto-compact shows context pressure in the button and keeps notices in its tooltip',()=>{
 const usage=(used:number,model='gpt-6-astra')=>({model,created:1,usage:{context_used:used,context_max:100}} as Turn);
 const render=(turns:Turn[],values:Partial<Chat>={})=>renderToStaticMarkup(React.createElement(ContextControls,{chat:{...chat,...values},turns,call:async()=>{}}));
 for(const [used,color] of [[0,'normal'],[69,'normal'],[70,'warning'],[89,'warning'],[90,'high'],[105,'high']] as const)assert.match(render([usage(used)]),new RegExp('data-pressure="'+color+'"'));
 assert.match(render([]),/data-pressure="neutral"/);
 assert.match(render([usage(95)],{autoCompact:false}),/data-pressure="neutral"/);
 assert.match(render([usage(25),usage(95,'claude-code:opus')],{selectedModels:['gpt-6-astra','claude-code:opus']}),/data-pressure="high"/);
 assert.match(render([usage(25),usage(95,'claude-code:opus')],{selectedModels:['gpt-6-astra','claude-code:opus'],lockedModel:'gpt-6-astra'}),/data-pressure="normal"/);
 const html=render([usage(25)],{contextNotice:'Auto-compaction did not finish. Use /compact to retry.'});
 assert.match(html,/Auto-compaction did not finish/);
 assert.doesNotMatch(html.replace(/<[^>]*>/g,''),/compaction did not finish|needs attention|Context saved/);
 assert.match(render([usage(80)],{compacting:{done:1,total:3}}),/Compacting · 1\/3/);
});
