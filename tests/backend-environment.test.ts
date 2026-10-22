import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {Backend} from '../app/backend';
import {claudeEnvironment} from '../app/claude';
import {execFileSync} from 'node:child_process';

test('both engines give PowerShell children a process-only exception', {skip:process.platform!=='win32'},()=>{
 const backend=new Backend(process.cwd(),path.resolve('work/policy'),'Trismegistus/Test/policy',()=>{});
 const policies=(env:NodeJS.ProcessEnv)=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command','Get-ExecutionPolicy -List | Select-Object @{n="Scope";e={$_.Scope.ToString()}},@{n="Policy";e={$_.ExecutionPolicy.ToString()}} | ConvertTo-Json -Compress'],{env,encoding:'utf8',windowsHide:true}));
 const parent={...claudeEnvironment(),PSExecutionPolicyPreference:process.env.PSExecutionPolicyPreference},before=policies(parent);
 for(const env of [backend.environment(),claudeEnvironment()] as NodeJS.ProcessEnv[]){
  assert.equal(env.PSExecutionPolicyPreference,'Bypass');
  assert.equal(execFileSync('powershell.exe',['-NoProfile','-Command','Get-ExecutionPolicy -Scope Process'],{env,encoding:'utf8',windowsHide:true}).trim(),'Bypass');
  const scopes=policies(env);
  for(const scope of ['MachinePolicy','UserPolicy'])assert.equal(scopes.find((row:any)=>row.Scope===scope).Policy,'Undefined');
  assert.deepEqual(scopes.filter((row:any)=>row.Scope!=='Process'),before.filter((row:any)=>row.Scope!=='Process'));
 }
 assert.deepEqual(policies(parent),before);
});

test('supplier shared auth stays under its owning app data folder',()=>{
 const original=process.env.HERMES_SHARED_AUTH_DIR;
 try{
  process.env.HERMES_SHARED_AUTH_DIR=path.resolve('work/unrelated-hermes');
  for(const name of ['first','second','first']){
   const data=path.resolve('work/environment-'+name),backend=new Backend(process.cwd(),data,'Trismegistus/Test/'+name,()=>{});
   assert.equal(backend.environment().HERMES_SHARED_AUTH_DIR,path.join(data,'hermes','shared'));
  }
 }finally{if(original===undefined)delete process.env.HERMES_SHARED_AUTH_DIR;else process.env.HERMES_SHARED_AUTH_DIR=original;}
});
