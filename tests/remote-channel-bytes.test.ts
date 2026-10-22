import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {gateChannel} from '../app/remote';

test('the private gateway preserves Unicode split across HTTP chunks',async()=>{
 const received:any[]=[],channel=await gateChannel({inbound:async value=>{received.push(value);},ready:()=>{},outbox:()=>[],sent:()=>{}});
 try{
  const value={text:'日本語の依頼 😀'},bytes=Buffer.from(JSON.stringify(value)),split=bytes.indexOf(Buffer.from('日'))+1;
  const response=new Promise<number>((resolve,reject)=>{
   const req=request(channel.connection.url+'inbound',{method:'POST',headers:{Authorization:'Bearer '+channel.connection.token}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode!));});
   req.once('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>req.end(bytes.subarray(split)),30);
  });
  assert.equal(await response,200);assert.deepEqual(received,[value]);
 }finally{channel.close();}
});
