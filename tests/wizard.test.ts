import test from 'node:test';
import assert from 'node:assert/strict';
import {wizardSummary} from '../app/wizard';

const fresh:any={connected:false,providerStatus:'Not connected',codex:{connected:false,status:'Not connected'},claude:{connected:false,status:'Claude Code not installed'},jev:{connected:false,status:'Not connected'},apiProviders:[],decisionEngine:{pickers:[]},alwaysOn:{startWithWindows:false,stayAwake:'remote'},remote:{enabled:false,status:'off',message:''}};

test('a fresh profile reads as skipped everywhere, each row with its next action',()=>{
 const rows=wizardSummary(fresh);
 assert.deepEqual(rows.map(row=>[row.name,row.outcome]),[['Suppliers','skipped'],['Claude Code','skipped'],['Jev','skipped'],['Start with Windows','skipped'],['Remote','skipped']]);
 assert.deepEqual(rows.map(row=>row.page),['connections','claude-code','connections','always-on','remote']);
});

test('connected, not verified yet and failed come from the live statuses, one row per supplier',()=>{
 const rows=wizardSummary({...fresh,connected:true,providerStatus:'Connected',apiProviders:[{provider:'gemini',connected:true,status:'Checking'},{provider:'mistral',connected:true,status:'No credit remaining'}],claude:{connected:true,status:'Signed in'},alwaysOn:{startWithWindows:true},remote:{enabled:true,status:'failed',message:'Token rejected'}});
 assert.deepEqual(rows.map(row=>[row.name,row.outcome]),[['DeepSeek','connected'],['Google · Gemini','unverified'],['Mistral · API','failed'],['Claude Code','connected'],['Jev','skipped'],['Start with Windows','connected'],['Remote','failed']]);
 assert.equal(rows.at(-1)!.detail,'Token rejected');
});

test('a rejected supplier connection remains a failed summary row',()=>{
 const rows=wizardSummary({...fresh,apiProviders:[{provider:'gemini',connected:false,status:'Authentication failed'},{provider:'mistral',connected:false,status:'Not connected'}]});
 assert.deepEqual(rows[0],{name:'Google · Gemini',outcome:'failed',detail:'Authentication failed',page:'connections',action:'Open Connections'});
 assert.equal(rows.some(row=>row.name==='Mistral · API'),false);
});
