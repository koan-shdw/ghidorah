import test from 'node:test';
import assert from 'node:assert/strict';
import {readAlwaysOn,loginItem,keepAwake} from '../app/always-on';

test('always on: his defaults, safe reading, own test entry, awake only when asked',()=>{
 assert.deepEqual(readAlwaysOn(undefined),{startWithWindows:false,stayAwake:'remote',desktopNotifications:true,questionSound:true});
 assert.deepEqual(readAlwaysOn({startWithWindows:'yes',stayAwake:'constructor'}),{startWithWindows:false,stayAwake:'remote',desktopNotifications:true,questionSound:true});
 assert.deepEqual(readAlwaysOn({startWithWindows:true,stayAwake:'always'}),{startWithWindows:true,stayAwake:'always',desktopNotifications:true,questionSound:true});
 assert.deepEqual(loginItem({packaged:true,execPath:'C:\\Apps\\Trismegistus.exe',appFolder:'C:\\Apps\\resources\\app.asar'}),{path:'C:\\Apps\\Trismegistus.exe',args:['--hidden'],name:'Ghidorah'});
 assert.deepEqual(loginItem({packaged:false,execPath:'C:\\repo\\electron.exe',appFolder:'C:\\repo'}),{path:'C:\\repo\\electron.exe',args:['C:\\repo','--hidden'],name:'Ghidorah Dev'});
 assert.deepEqual(loginItem({packaged:false,execPath:'C:\\repo\\electron.exe',appFolder:'C:\\repo',testData:'C:\\repo\\work\\always-on-abc'}),{path:'C:\\repo\\electron.exe',args:['C:\\repo','--hidden'],name:'Ghidorah Test always-on-abc'});
 assert.equal(keepAwake('always',false),true);assert.equal(keepAwake('remote',false),false);assert.equal(keepAwake('remote',true),true);assert.equal(keepAwake('off',true),false);
});
