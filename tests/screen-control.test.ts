import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {ScreenDriver,screenTarget,hermesScreenTarget,sendsEscape,appName,sameApp,processName,screenToolNames,screenBarPage} from '../app/screen-control';

test('screen control: what each action touches, so Koan is asked about the right app (FEATURE-SPECS 1.4)',()=>{
 assert.deepEqual(screenTarget('list_apps',{}),{kind:'none'},'listing apps shows no window contents');
 assert.deepEqual(screenTarget('get_desktop_state',{}),{kind:'screen'});
 assert.deepEqual(screenTarget('click',{pid:42,x:1,y:2}),{kind:'app',pid:42});
 assert.deepEqual(screenTarget('click',{x:1,y:2}),{kind:'screen'},'an action with no app is treated as the whole screen');
 assert.deepEqual(screenTarget('launch_app',{name:'notepad'}),{kind:'named',name:'Notepad'});
 assert.deepEqual(screenTarget('launch_app',{path:'C:\\Program Files\\Adobe\\Photoshop.exe'}),{kind:'named',name:'Photoshop'});
 assert.deepEqual(screenTarget('zoom',{x1:0,y1:0,x2:10,y2:10}),{kind:'none'},'a zoom reads a snapshot already approved');
 assert.deepEqual(hermesScreenTarget({action:'capture',app:'screen'}),{kind:'screen'});
 assert.deepEqual(hermesScreenTarget({action:'click',pid:7}),{kind:'app',pid:7});
 assert.deepEqual(hermesScreenTarget({action:'capture',app:'Safari'}),{kind:'named',name:'Safari'});
 assert.deepEqual(hermesScreenTarget({action:'list_windows'}),{kind:'none'});
 assert.deepEqual(hermesScreenTarget({action:'click'}),{kind:'screen'},'the frontmost window could be anything');
 assert.ok(sendsEscape('press_key',{key:'escape'}));assert.ok(sendsEscape('hotkey',{keys:['ctrl','esc']}));assert.ok(sendsEscape('computer_use',{action:'key',keys:'Escape'}));
 assert.ok(!sendsEscape('press_key',{key:'return'}));assert.ok(!sendsEscape('type_text',{text:'escape'}));
 assert.equal(appName('photoshop.exe'),'Photoshop');assert.ok(sameApp('Photoshop','photoshop'));
 assert.ok(!screenToolNames.has('kill_app')&&!screenToolNames.has('clipboard_read')&&!screenToolNames.has('browser_navigate'));
 assert.match(decodeURIComponent(screenBarPage('Opus is controlling <Notepad>')),/Opus is controlling &lt;Notepad&gt;.*Esc to stop/);
});

test('screen control: the driver lists only allowed tools and refuses the rest; process names come from Windows',async()=>{
 const driver=new ScreenDriver(()=>path.resolve('tests/fixtures/fake-cua-driver.cmd'),process.env as Record<string,string>);
 try{
  const names=(await driver.tools()).map((tool:any)=>tool.name).sort();
  assert.deepEqual(names,['click','get_desktop_state','get_window_state','list_apps']);
  assert.match(JSON.stringify(await driver.call('click',{pid:1,x:1,y:1})),/fake click done/);
  await assert.rejects(driver.call('kill_app',{pid:1}),/not available/);
 }finally{driver.stop();}
 assert.equal(await processName(process.pid),'Node');
});
