// updates: moved out of app/main.ts unchanged (SPLIT-PLAN); module state stays in main.ts.
import {namespace,root,store} from '../main';
import {APP_FEED,Feed,HERMES_RELEASES,UpdateMode} from '../updates';
import {readFileSync} from 'node:fs';
import path from 'node:path';

// skip: a version that did not open and was rolled back; automaticOnce: the old Manual default became Automatic once.
export function updateSettings(){const row=store.all<any>('settings').find(row=>row.id==='updates');return {mode:(row?.mode==='automatic'?'automatic':'manual') as UpdateMode,lastSeen:typeof row?.lastSeen==='string'?row.lastSeen:undefined,skip:typeof row?.skip==='string'?row.skip:undefined,automaticOnce:!!row?.automaticOnce};}
export function updateFeed():Feed{return (namespace.startsWith('Trismegistus/Test/')&&process.env.TRISMEGISTUS_TEST_UPDATE_FEED)||APP_FEED;}
export function discoverySettings(){const row=store.all<any>('settings').find(row=>row.id==='model-discovery');return {mode:row?.mode==='session'?'session':'manual',model:typeof row?.model==='string'?row.model:''};}
export function hermesPin(){try{const manifest=JSON.parse(readFileSync(path.join(root,'runtime','hermes-manifest.json'),'utf8'));return {tag:String(manifest.upstreamTag||''),version:String(manifest.upstreamVersion||'unknown'),published:String(manifest.upstreamPublished||''),fork:String(manifest.fork||'')};}catch{return {tag:'',version:'unknown',published:'',fork:''};}}
export function hermesFeed(){return namespace.startsWith('Trismegistus/Test/')?process.env.TRISMEGISTUS_TEST_HERMES_FEED:HERMES_RELEASES;}
