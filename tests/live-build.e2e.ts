import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
if(process.env.TRISMEGISTUS_LIVE_BUILD!=='1')throw Error('Explicit live build opt-in required.');
const root=path.resolve('.'),stamp=Date.now(),gate=path.join(root,'work','live-build-approved-'+stamp),record=path.join(root,'work','live-build-review.json');
const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
const instance=await electron.launch({args:[root],env,timeout:30000});
try{
  const page=await instance.firstWindow();
  const call=(method:string,args:any={})=>page.evaluate(({method,args})=>window.desktop.invoke(method,args),{method,args});
  let state:any;
  const deadline=Date.now()+300000;
  while(Date.now()<deadline){state=await call('state');if(state.backend==='ready'&&state.codex?.models.length)break;await page.waitForTimeout(200);}
  assert.ok(state.defaultFolder);const relative='trismegistus-harness-'+stamp,folder=path.join(state.defaultFolder,relative);
  const command='python -m unittest discover -s "'+relative+'" -v';
  const model=state.codex.models.includes('gpt-6-sol')?'gpt-6-sol':state.codex.models[0];
  const chatId=await call('addProject');await call('addModel',{chatId,model});await call('modelSelection',{chatId,model,selected:true});await call('effort',{chatId,model,effort:'low'});
  const id=crypto.randomUUID();
  await call('submit',{id,chatId,text:`Build a small Python calculator in a new folder named ${relative}. Create calc.py with add, subtract, multiply and divide functions; divide by zero must raise ValueError. Create test_calc.py with unittest tests covering those operations and division by zero. Use write_file for these two files, then use terminal to run exactly this command: ${command}. Use no dependencies. Report the test result.`});
  const seen=new Set<string>();let reviewed=false;
  while(Date.now()<deadline){
    state=await call('state');const turn=state.turns.find((turn:any)=>turn.id===id);
    for(const approval of state.approvals.filter((approval:any)=>approval.turnId===id&&approval.status==='pending'&&!seen.has(approval.id))){
      seen.add(approval.id);
      // Hermes asks before emitting tool.start. Our permission plugin includes
      // the exact tool and JSON arguments in the approval description.
      const match=String(approval.params.description||'').match(/^(\w+): ([\s\S]+)$/);assert.ok(match,'Expected a structured plugin approval');
      const tool={name:match[1],args:JSON.parse(match[2])};
      if(tool.name==='write_file'){
        const file=path.resolve(state.defaultFolder,tool.args.path||tool.args.file_path);
        assert.ok(['calc.py','test_calc.py'].includes(path.basename(file))&&path.dirname(file)===folder,'Unexpected file target');
      }else if(tool.name==='terminal'){
        assert.equal(tool.args.command.trim(),command);
        await fs.writeFile(record,JSON.stringify({chatId,turnId:id,folder,command,gate,model},null,2));
        console.log('REVIEW generated code before command approval: '+record);
        while(Date.now()<deadline&&!await fs.access(gate).then(()=>true,()=>false))await page.waitForTimeout(250);
        assert.ok(await fs.access(gate).then(()=>true,()=>false),'Code review gate not completed');reviewed=true;
      }else throw Error('Unexpected approved tool: '+tool.name);
      await call('approve',{id:approval.id,choice:'once'});
    }
    if(['completed','failed','interrupted'].includes(turn.status)){
      assert.equal(turn.status,'completed',turn.error);assert.equal(reviewed,true);
      const commandTool=state.tools.filter((tool:any)=>tool.turnId===id&&tool.name==='terminal').at(-1);assert.match(JSON.stringify(commandTool.result),/OK/);
      console.log('PASS real GPT build, approved Python test command and successful test output: '+folder);break;
    }
    await page.waitForTimeout(150);
  }
  assert.equal(state.turns.find((turn:any)=>turn.id===id).status,'completed','Live build timed out');
}finally{await instance.evaluate(({app})=>app.quit());await instance.close();}
