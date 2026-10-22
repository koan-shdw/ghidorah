// Approved fixed speech sample, with the entire source archive verified before reading a single member.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

export const KWS={url:'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2',size:17626723,sha256:'f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a',folder:'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01'};
export async function speechClip(assets:string,name:'0.wav'|'1.wav'){
 await fs.mkdir(assets,{recursive:true});
 if((await fs.realpath(assets)).toLowerCase()!==path.resolve(assets).toLowerCase())throw Error('Test assets must not be redirected.');
 const archive=path.join(assets,'kws.tar.bz2'),hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
 let bytes=await fs.readFile(archive).catch(()=>Buffer.alloc(0));
 if(bytes.length!==KWS.size||hash(bytes)!==KWS.sha256){
  const response=await fetch(KWS.url,{signal:AbortSignal.timeout(120000)});if(!response.ok||!response.body)throw Error('Speech fixture download failed: HTTP '+response.status);
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>KWS.size)throw Error('Speech fixture exceeded its pinned size.');chunks.push(value);}}finally{await reader.cancel();}
  bytes=Buffer.concat(chunks);if(bytes.length!==KWS.size||hash(bytes)!==KWS.sha256)throw Error('Speech fixture did not match its pinned hash.');
  await fs.writeFile(archive,bytes);
 }
 // tar writes this exact member to stdout; no archive path is ever extracted onto the filesystem.
 const read=(member:string)=>execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'),['-xOf',archive,KWS.folder+'/test_wavs/'+member],{windowsHide:true,maxBuffer:8*1024*1024});
 const clip=read(name),lines=read('trans.txt').toString('utf8').split(/\r?\n/),text=lines.find(line=>line.startsWith(name+' '))?.slice(name.length+1);
 if(!text||clip.subarray(0,4).toString()!=='RIFF'||clip.subarray(8,12).toString()!=='WAVE')throw Error('Invalid speech fixture.');
 const file=path.join(assets,name);await fs.writeFile(file,clip);return {file,text};
}
