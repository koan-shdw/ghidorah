import test from 'node:test';
import assert from 'node:assert/strict';
import {wizardSummary} from '../app/wizard';

const fresh:any={connected:false,providerStatus:'Not connected',codex:{connected:false,status:'Not connected'},claude:{connected:false,status:'Claude Code not installed'},jev:{connected:false,status:'Not connected'},apiProviders:[],decisionEngine:{pickers:[]},alwaysOn:{startWithWindows:false,stayAwake:'remote'},remote:{enabled:false,status:'off',message:''}};

test('a fresh profile reads as skipped everywhere, each row with its next action',()=>{
 const rows=wizardSummary(fresh);
 assert.deepEqual(rows.map(row=>[row.name,row.outcome]),[['Suppliers','skipped'],['Claude Code','skipped'],['Jev','skipped'],['Listening','skipped'],['Voice','skipped'],['Start with Windows','skipped'],['Remote','skipped'],['Share with clients','skipped']]);
 assert.deepEqual(rows.map(row=>row.page),['connections','connections:anthropic','connections','voice','voice','always-on','remote','sharing']);
 assert.equal(rows.find(row=>row.name==='Listening')!.detail,'No listening engine set up. Dictation needs one.');
});

// Koan 2026-11-15: the wizard sets up what hears dictation and downloads the voice that reads replies.
test('listening and the reply voice say what is set up',()=>{
 const voices={installed:true,defaultId:'ring',list:[{id:'heart',name:'Heart'},{id:'ring',name:'Ring machine'}]};
 const rows=wizardSummary({...fresh,voice:{listening:{engine:'whisper',hints:true,connected:{deepgram:false,elevenlabs:false}}},voices});
 assert.deepEqual(rows.filter(row=>['Listening','Voice'].includes(row.name)).map(row=>[row.outcome,row.detail,row.action]),[['connected','Whisper, on this PC','Open Voice'],['connected','Kokoro installed · Ring machine','Open Voice']]);
 assert.equal(wizardSummary({...fresh,voice:{listening:{engine:'deepgram',hints:true,connected:{deepgram:true,elevenlabs:false}}}}).find(row=>row.name==='Listening')!.detail,'Deepgram Nova-3, online');
 assert.equal(wizardSummary({...fresh,voices:{...voices,installed:false}}).find(row=>row.name==='Voice')!.detail,'Not installed. Listen and Speak replies need it.');
});

test('connected, not verified yet and failed come from the live statuses, one row per supplier',()=>{
 const rows=wizardSummary({...fresh,connected:true,providerStatus:'Connected',apiProviders:[{provider:'gemini',connected:true,status:'Checking'},{provider:'mistral',connected:true,status:'No credit remaining'}],claude:{connected:true,status:'Signed in'},alwaysOn:{startWithWindows:true},remote:{enabled:true,status:'failed',message:'Token rejected'}});
 assert.deepEqual(rows.map(row=>[row.name,row.outcome]),[['DeepSeek','connected'],['Google · Gemini','unverified'],['Mistral · API','failed'],['Claude Code','connected'],['Jev','skipped'],['Listening','skipped'],['Voice','skipped'],['Start with Windows','connected'],['Remote','failed'],['Share with clients','skipped']]);
 assert.equal(rows.find(row=>row.name==='Remote')!.detail,'Token rejected');
});

test('a rejected supplier connection remains a failed summary row',()=>{
 const rows=wizardSummary({...fresh,apiProviders:[{provider:'gemini',connected:false,status:'Authentication failed'},{provider:'mistral',connected:false,status:'Not connected'}]});
 assert.deepEqual(rows[0],{name:'Google · Gemini',outcome:'failed',detail:'Authentication failed',page:'connections',action:'Open Connections'});
 assert.equal(rows.some(row=>row.name==='Mistral · API'),false);
});
