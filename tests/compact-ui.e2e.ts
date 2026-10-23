// Visual/component checks with explicit synthetic usage. No provider calls.
import {_electron as electron} from 'playwright';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('.'),folder=await fs.mkdtemp(path.join(root,'work','usage-layout-'));
const result=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import {UsagePanel} from './app/usage-panel';import {ModelPool} from './app/model-pool';
const now=Date.now(),models=['deepseek-flash','gpt-6-sol','claude-code:fable'];
const state={chats:[{id:'chat',title:'New project',pool:models}],connected:true,balance:'USD 8.42',balanceCheckedAt:new Date(now).toISOString(),favouriteModels:['gpt-6-sol'],codex:{connected:true,models:['gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra'],plan:'Pro',status:'Connected',checkedAt:new Date(now).toISOString(),windows:[{label:'Weekly',usedPercent:81,resetAt:new Date(now+172800000).toISOString()}]},claude:{connected:true,models:[{id:'claude-code:opus',label:'Opus',efforts:[]},{id:'claude-code:fable',label:'Fable 5.1',efforts:[]},{id:'claude-code:haiku',label:'Haiku',efforts:[]}],plan:'Max',status:'Connected',checkedAt:new Date(now).toISOString(),windows:[{label:'5-hour limit',usedPercent:100,resetAt:new Date(now+3480000).toISOString()},{label:'Weekly · all models',usedPercent:16,resetAt:new Date(now+172800000).toISOString()},{label:'Weekly · Fable',usedPercent:32,resetAt:new Date(now+172800000).toISOString()}]}};
const turns=models.map((model,i)=>({model,created:now,usage:{turn_total:[9136,35763,89083][i],context_used:[9133,7719,29814][i],context_max:[1000000,272000,1000000][i],context_source:i===2?'claude_code':'provider_usage'}}));
const render=(screen='usage',missing=false)=>createRoot(document.getElementById('root')).render(screen==='usage'?<div className="bottom-area" style={{position:'fixed',bottom:0,right:0}}><UsagePanel state={missing?{...state,codex:{...state.codex,windows:[]},claude:{...state.claude,windows:[{label:'Weekly',usedPercent:null,resetAt:null}]}}:state} turns={missing?[]:turns} models={models} refresh={async()=>{}} close={()=>{}}/></div>:<div className="modal-backdrop"><div className="settings"><header><h2>Chat models</h2></header><div className="settings-body"><ModelPool state={state} chatId="chat" call={async()=>{}} connections={()=>{}}/></div></div></div>);
render(new URLSearchParams(location.search).get('screen')||'usage',location.search.includes('missing'));
`},bundle:true,write:false,format:'iife'});
await fs.writeFile(path.join(folder,'ui.js'),result.outputFiles[0].text);
// The app's stylesheets in its own order: tokens and themes first (every size and colour since 0.1.18), then the kit.
for(const sheet of ['tokens.css','themes.css','kit.css','ui.css'])await fs.copyFile(path.join(root,'app',sheet),path.join(folder,sheet));
await fs.writeFile(path.join(folder,'index.html'),'<html><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="themes.css"><link rel="stylesheet" href="kit.css"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>');
await fs.writeFile(path.join(folder,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(folder,'data'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1280,height:900});w.loadFile(${JSON.stringify(path.join(folder,'index.html'))});});`);
const instance=await electron.launch({args:[path.join(folder,'main.cjs')],timeout:30000});
try{
 const page=await instance.firstWindow();await page.getByRole('dialog',{name:'Context window and usage'}).waitFor();
 const panel=page.locator('.usage-panel');
 const overview=async()=>{
   assert.ok(await panel.evaluate(e=>e.getBoundingClientRect().left>=0&&e.getBoundingClientRect().right<=innerWidth));
   assert.ok(await page.locator('.usage-scroll').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'overview should fit without scrolling');
   assert.ok(await panel.evaluate(e=>e.scrollWidth<=e.clientWidth),'no horizontal overflow');
 };
 await overview();
 assert.equal(await page.getByRole('progressbar',{name:'Claude Code 5-hour limit remaining'}).getAttribute('value'),'0');
 assert.equal(await page.getByRole('progressbar',{name:'OpenAI Weekly remaining'}).getAttribute('value'),'19');
 assert.equal(await page.getByRole('progressbar',{name:'DeepSeek context used'}).getAttribute('value'),'9133');
 assert.match(await panel.innerText(),/0% left/);
 await page.screenshot({path:path.join(root,'work','usage-compact.png')});
 await page.getByText('Exact counts & reporting details',{exact:true}).click();
 assert.match(await page.locator('.usage-details').innerText(),/89,083 tokens/);
 await page.getByText('Exact counts & reporting details',{exact:true}).click();
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(900,700));await page.screenshot({path:path.join(root,'work','usage-compact-small.png')});await overview();
 await page.screenshot({path:path.join(root,'work','usage-compact-small.png')});
 await page.goto(new URL('file:///'+path.join(folder,'index.html').replaceAll('\\','/')+'?missing=1').href);
 await panel.waitFor();assert.equal(await page.getByRole('progressbar').count(),0);assert.match(await panel.innerText(),/Unavailable/);assert.match(await panel.innerText(),/Windows unavailable/);
 await page.goto(new URL('file:///'+path.join(folder,'index.html').replaceAll('\\','/')+'?screen=models').href);
 await page.getByRole('region',{name:'All available models',exact:true}).waitFor();
 const gpt=page.getByRole('region',{name:'OpenAI models',exact:true});
 const tops=await gpt.locator('.pool-pill').evaluateAll(items=>items.map(e=>e.getBoundingClientRect().top));assert.ok(new Set(tops).size>1,'pills wrap');
 assert.deepEqual(await page.locator('.pool-group h5').allTextContents(),['Anthropic','DeepSeek','OpenAI']);
 await page.screenshot({path:path.join(root,'work','model-pool-catalogue.png')});
 console.log('PASS compact usage fits at 900×700, separate remaining/context scales, full details, missing data, supplier grouping and wrapped pills');
}finally{await instance.close();}
