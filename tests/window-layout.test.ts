import {test} from 'node:test';
import assert from 'node:assert/strict';
import {visibleWindowBounds} from '../app/window-layout';
test('restored windows remain visible after monitor removal and invalid saved bounds',()=>{
 const area={x:0,y:0,width:1280,height:720};assert.deepEqual(visibleWindowBounds({x:6000,y:-2000,width:900,height:650},area),{x:380,y:0,width:900,height:650});assert.deepEqual(visibleWindowBounds({width:Infinity,height:-5,x:NaN},area),{x:250,y:160,width:780,height:400});
 const left={x:-1920,y:0,width:1920,height:1080};assert.deepEqual(visibleWindowBounds({x:-1600,y:30,width:800,height:600},left),{x:-1600,y:30,width:800,height:600});assert.deepEqual(visibleWindowBounds({width:9000,height:9000},area),{x:0,y:0,width:1280,height:720});
});
