import {_electron as electron} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {PYTHON} from '../app/backend';

const root=path.resolve('.'),data=await fs.mkdtemp(path.join(root,'work','plugin-commands-')),source=path.join(data,'fixture-plugin'),folder=path.join(data,'workspace');await fs.mkdir(source);await fs.mkdir(folder);
await fs.writeFile(path.join(source,'plugin.yaml'),JSON.stringify({name:'command-example',version:'1',requires_env:['COMMAND_FIXTURE_TOKEN'],config_schema:{prefix:{type:'string',default:'from-settings'}}}));
await fs.writeFile(path.join(source,'__init__.py'),`import asyncio, json, os, subprocess, sys, time
from pathlib import Path
from gateway.session_context import get_session_env
from agent.secret_scope import get_secret
from hermes_constants import get_hermes_home

def register(ctx):
    def record(arg):
        chat=get_session_env('HERMES_SESSION_CHAT_ID')
        value={'chat':chat, 'turn':get_session_env('HERMES_SESSION_ID'), 'profile':str(get_hermes_home()), 'cwd':os.getcwd(), 'arg':arg, 'setting':ctx.get_config('prefix')}
        # One file per call: two plugin processes appending to one file at once can lose a line on Windows.
        Path('calls').mkdir(exist_ok=True); Path('calls', str(time.time_ns())+'-'+str(os.getpid())+'.json').write_text(json.dumps(value), encoding='utf8')
        print('COMMAND-START '+chat, flush=True)
        secret=get_secret('COMMAND_FIXTURE_TOKEN')
        sys.stdout.write(secret[:9]); print(secret[9:], flush=True)
        if arg=='wait':
            heartbeat=str(Path('heartbeat-'+chat+'.txt').resolve())
            code='from pathlib import Path; import time; p=Path('+repr(heartbeat)+');\\nwhile True:\\n p.open("a").write("x"); time.sleep(0.1)'
            child=subprocess.Popen([sys.executable,'-c',code], creationflags=subprocess.CREATE_NO_WINDOW)
            Path('child-'+chat+'.txt').write_text(str(child.pid))
            print('WAIT_READY', flush=True)
            while True: time.sleep(0.2)
        if arg in ('tool','tool-deny'):
            return ctx.dispatch_tool('write_file', {'path':str(Path(arg+'-'+chat+'.txt').resolve()), 'content':'APPROVED-TOOL'})
        return 'COMMAND-RESULT '+json.dumps(value)
    async def asynchronous(arg):
        await asyncio.sleep(0.01)
        if arg.startswith('aux-'):
            from agent.auxiliary_client import call_llm
            base=json.loads((get_hermes_home()/'config.yaml').read_text())['model']['base_url']
            result=call_llm(task='title_generation', provider='deepseek', model='deepseek-flash', base_url=base, messages=[{'role':'user','content':'EXHAUST_SIDE_FIXTURE' if arg=='aux-exhaust' else 'A short title'}], timeout=8)
            return result.choices[0].message.content
        return 'ASYNC-RESULT '+arg
    ctx.register_command('record', record, description='Record the current chat and working folder.')
    ctx.register_command('async', asynchronous, description='Async command fixture.')
`);
const ds=spawn(PYTHON,['tests/fake_provider.py'],{env:{...process.env,FIXTURE_RECORDS:path.join(data,'requests.jsonl'),FIXTURE_AUX_RECORDS:path.join(data,'aux.jsonl')},windowsHide:true,stdio:'pipe'}),lines=createInterface({input:ds.stdout}),[line]=await once(lines,'line');
const env={...process.env,TRISMEGISTUS_TEST_DATA:data,TRISMEGISTUS_TEST_PROVIDER_URL:JSON.parse(line).url};
const launch=()=>electron.launch({executablePath:process.env.TRISMEGISTUS_EXE,args:process.env.TRISMEGISTUS_EXE?[]:[root],env,timeout:30000});let instance=await launch();
try{
 await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));let page=await instance.firstWindow();
 const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
 const wait=async(predicate:(state:any)=>boolean)=>{const until=Date.now()+90000;while(Date.now()<until){const state=await call('state');if(predicate(state))return state;await page.waitForTimeout(100);}throw Error('Timed out: '+JSON.stringify((await call('state')).turns));};
 const logs=()=>fs.readdir(path.join(folder,'calls')).then(names=>Promise.all(names.sort().map(name=>fs.readFile(path.join(folder,'calls',name),'utf8').then(text=>JSON.parse(text)))),()=>[]);
 const heartbeatReady=async(chat:string)=>{const file=path.join(folder,'heartbeat-'+chat+'.txt');for(let n=0;n<100;n++){if(await fs.stat(file).then(stat=>stat.size>0,()=>false))return;await page.waitForTimeout(100);}throw Error('Child heartbeat did not start');};
 const childStopped=async(chat:string)=>{const pid=Number(await fs.readFile(path.join(folder,'child-'+chat+'.txt'),'utf8'));for(let n=0;n<100;n++){try{process.kill(pid,0);}catch{return;}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Command child survived Stop or app death');};
 const send=async(chatId:string,arg:string,name='record')=>{const id=crypto.randomUUID();await call('submit',{id,chatId,text:'/command-example:'+name+(arg?' '+arg:'')});return id;};
 const approval=async(id:string,choice='once')=>{const state=await wait(state=>state.approvals.some((row:any)=>row.turnId===id&&row.status==='pending'));const item=state.approvals.find((row:any)=>row.turnId===id&&row.status==='pending');await call('approve',{id:item.id,choice});return item.id;};
 const done=async(id:string,status='completed')=>{const state=await wait(state=>state.turns.some((row:any)=>row.id===id&&['completed','interrupted','stopped'].includes(row.status)));const turn=state.turns.find((row:any)=>row.id===id);assert.equal(turn.status,status,turn.error);return turn;};
 await wait(state=>state.backend==='ready');assert.equal((await call('state')).connected,false);
 const a=await call('addProject'),b=await call('addProject');const projects=(await call('state')).projects;
 const review=await call('pluginRepositoryReview',{repository:'fixture/plugin'});await call('nativePluginInstall',{token:review.token,values:{'env:COMMAND_FIXTURE_TOKEN':'synthetic-command-credential'}});
 const installed=(await call('nativePlugins')).installed[0];const catalog=(await call('state')).commands;assert.equal(catalog.filter((row:any)=>row.kind==='Plugin command').length,2);
 assert.equal((await logs()).length,0,'Discovery must not invoke handlers');
 let id=await send(a,'no-folder');assert.match((await done(id,'interrupted')).error,/root working folder/);assert.equal((await logs()).length,0);
 await call('workingFolder',{folder});
 id=await send(a,'denied');const oldApproval=await approval(id,'deny');assert.match((await done(id,'interrupted')).error,/denied/);assert.equal((await logs()).length,0);
 const first=await send(a,'alpha'),second=await send(b,'beta');await approval(second);await approval(first);const [at,bt]=await Promise.all([done(first),done(second)]);
 for(const [turn,chat] of [[at,a],[bt,b]]){assert.match(turn.text,/COMMAND-RESULT/);assert.match(turn.text,new RegExp(chat));assert.doesNotMatch(turn.text,/synthetic-command-credential/);assert.match(turn.text,/redacted/);}
 const recorded=await logs(),chats=(await call('state')).chats;assert.equal(recorded.length,2);for(const row of recorded){const project=projects.find((p:any)=>p.id===chats.find((c:any)=>c.id===row.chat).projectId);assert.equal(row.profile,path.join(data,'hermes/profiles',project.profile));assert.equal(row.cwd,folder);assert.equal(row.setting,'from-settings');}
 await call('submit',{id:first,chatId:a,text:'/command-example:record alpha'});await call('approve',{id:oldApproval,choice:'once'});assert.equal((await logs()).length,2);
 await assert.rejects(call('submit',{id:first,chatId:b,text:'/command-example:record alpha'}),/already used/);
 if(await page.getByRole('button',{name:'Close settings',exact:true}).count())await page.getByRole('button',{name:'Close settings',exact:true}).click();
 await page.locator('[data-chat-id="'+a+'"] .chat-link').click();const message=page.getByRole('combobox',{name:'Message',exact:true}),beforePicker=(await call('state')).turns.length;
 await message.fill('/command-example:async');const option=page.getByRole('option',{name:/\/command-example:async/});assert.match(await option.innerText(),/Plugin command/);await option.click();assert.equal((await call('state')).turns.length,beforePicker);
 await message.fill('/command-example:async literal $&');await page.getByRole('button',{name:'Send',exact:true}).click();const pending=await wait(state=>state.turns.some((turn:any)=>turn.chatId===a&&turn.prompt==='/command-example:async literal $&'&&turn.status==='waiting'));id=pending.turns.find((turn:any)=>turn.prompt==='/command-example:async literal $&').id;
 await page.getByRole('button',{name:'Allow once',exact:true}).waitFor();await page.screenshot({path:path.join(data,'command-approval.png')});await page.getByRole('button',{name:'Allow once',exact:true}).click();assert.match((await done(id)).text,/ASYNC-RESULT literal \$&/);
 console.log('PASS real Hermes handler discovery, no provider required, approvals/denial, async, encrypted settings, redaction, two-chat identity and duplicate refusal');
 id=await send(a,'tool');await approval(id);await approval(id);assert.match((await done(id)).text,/success|written|wrote/i);assert.equal(await fs.readFile(path.join(folder,'tool-'+a+'.txt'),'utf8'),'APPROVED-TOOL');
 id=await send(a,'tool-deny');await approval(id);await approval(id,'deny');assert.match((await done(id)).text,/denied|declined/i);assert.equal(await fs.access(path.join(folder,'tool-deny-'+a+'.txt')).then(()=>true,()=>false),false);
 await call('mode',{projectId:projects[0].id,mode:'plan'});id=await send(a,'plan');assert.match((await done(id,'interrupted')).error,/Plan mode/);
 await call('mode',{projectId:projects[0].id,mode:'manual'});
 const wa=await send(a,'wait'),wb=await send(b,'wait');await approval(wa);await approval(wb);await wait(state=>[wa,wb].every(id=>state.turns.some((turn:any)=>turn.id===id&&turn.text.includes('WAIT_READY'))));
 await heartbeatReady(a);await heartbeatReady(b);
 await call('stop',{chatId:a});await done(wa,'stopped');await childStopped(a);const heartbeatA=await fs.readFile(path.join(folder,'heartbeat-'+a+'.txt'),'utf8');const heartbeatB=await fs.readFile(path.join(folder,'heartbeat-'+b+'.txt'),'utf8');await page.waitForTimeout(2100);assert.equal(await fs.readFile(path.join(folder,'heartbeat-'+a+'.txt'),'utf8'),heartbeatA);assert.ok((await fs.readFile(path.join(folder,'heartbeat-'+b+'.txt'),'utf8')).length>heartbeatB.length);
 await call('mode',{projectId:projects[1].id,mode:'plan'});await done(wb,'stopped');await call('mode',{projectId:projects[1].id,mode:'bypass'});id=await send(b,'bypass');await done(id);assert.equal((await call('state')).approvals.filter((row:any)=>row.turnId===id).length,0);
 await call('mode',{projectId:projects[1].id,mode:'manual'});
 id=await send(a,'wait');await approval(id);await wait(state=>state.turns.some((turn:any)=>turn.id===id&&turn.text.includes('WAIT_READY')));await heartbeatReady(a);const countBeforeCrash=(await logs()).length;
 // The Windows development launcher can have a different PID from Electron's main process.
 const mainPid=await instance.evaluate(()=>process.pid);
 execFileSync('taskkill',['/PID',String(mainPid),'/F'],{windowsHide:true,stdio:'pipe'});
 await childStopped(a);const heartbeatBefore=await fs.readFile(path.join(folder,'heartbeat-'+a+'.txt'),'utf8');await new Promise(resolve=>setTimeout(resolve,2100));assert.equal(await fs.readFile(path.join(folder,'heartbeat-'+a+'.txt'),'utf8'),heartbeatBefore);
 await instance.close().catch(()=>{});instance=await launch();await instance.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.hide()));page=await instance.firstWindow();await wait(state=>state.backend==='ready'&&state.commands?.filter((row:any)=>row.plugin!=='Trismegistus').length===2);await done(id,'interrupted');assert.equal((await logs()).length,countBeforeCrash);assert.equal((await call('state')).tools.find((row:any)=>row.turnId===id).status,'uncertain');
 await call('submit',{id,chatId:a,text:'/command-example:record wait'});assert.equal((await logs()).length,countBeforeCrash);
 await call('saveKey',{key:'synthetic-deepseek-regression-credential'});await call('modelSelection',{chatId:a,model:'deepseek-flash',selected:true});const local=await send(a,'selection-check','async');await approval(local);await done(local);assert.deepEqual((await call('state')).chats.find((chat:any)=>chat.id===a).selectedModels,['deepseek-flash']);const chatTurn=crypto.randomUUID();await call('submit',{id:chatTurn,chatId:a,text:'Remember the earlier command result without repeating it.'});await done(chatTurn);assert.match(await fs.readFile(path.join(data,'requests.jsonl'),'utf8'),/COMMAND-RESULT/);assert.equal((await logs()).length,countBeforeCrash);
 console.log('PASS nested Hermes tool approval, Plan/Bypass, chat-scoped Stop, process-tree cleanup, mode-change cancellation, app-death cleanup, no replay and model handover');
 await call('nativePluginToggle',{id:installed.id,enabled:false});assert.equal((await call('state')).commands.filter((row:any)=>row.plugin!=='Trismegistus').length,0);await call('nativePluginToggle',{id:installed.id,enabled:true});
 id=await send(a,'aux-ok','async');await approval(id);assert.match((await done(id)).text,/APPROVE/);
 id=await send(a,'aux-exhaust','async');await approval(id);await done(id,'interrupted');assert.equal((await call('state')).availableModels.includes('deepseek-flash'),false);
 const auxCount=(await fs.readFile(path.join(data,'aux.jsonl'),'utf8')).trim().split('\n').length;
 id=await send(b,'aux-ok','async');await approval(id);await done(id,'interrupted');assert.equal((await fs.readFile(path.join(data,'aux.jsonl'),'utf8')).trim().split('\n').length,auxCount);
 await call('checkAccount');id=await send(b,'aux-ok','async');await approval(id);assert.match((await done(id)).text,/APPROVE/);console.log('PASS supervised plugin auxiliary failure blocks the shared account, refuses another worker and restores after a free check');
 await fs.appendFile(path.join(installed.directory,'__init__.py'),'\n# changed');id=await send(a,'tampered');assert.match((await done(id,'interrupted')).error,/plugin changed/);assert.equal((await logs()).length,countBeforeCrash);
 const journal=new DatabaseSync(path.join(data,'chat.sqlite'),{readOnly:true});const actions=journal.prepare("SELECT data FROM records WHERE kind='work-action'").all().map((row:any)=>JSON.parse(row.data));journal.close();
 assert.ok(actions.some(action=>action.name==='write_file'&&action.status==='completed'&&path.basename(action.args.path)==='tool-'+a+'.txt'));assert.ok(actions.some(action=>action.name==='write_file'&&action.status==='blocked'&&path.basename(action.args.path)==='tool-deny-'+a+'.txt'));
 await fs.writeFile(path.join(data,'verified.json'),JSON.stringify({checks:['no provider','catalogue','sync/async','initial and nested approval','deny','shared tool-action journal','scope','redaction','Plan/Bypass','Stop and child process','mode change','crash and restart','no replay','model handover','off/re-enable','tamper','auxiliary account gate and restoration']},null,2));console.log('PASS command lifecycle '+data);
}finally{await instance.evaluate(({app})=>app.quit()).catch(()=>{});await instance.close().catch(()=>{});ds.stdin.end();lines.close();}
