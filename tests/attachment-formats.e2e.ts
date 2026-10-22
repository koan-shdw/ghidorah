import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Backend,PYTHON} from '../app/backend';
import {saveAttachment,attachmentContent} from '../app/attachments';
const root=process.env.TRISMEGISTUS_EXE?path.join(path.dirname(process.env.TRISMEGISTUS_EXE),'resources'):path.resolve('.');
const data=await fs.mkdtemp(path.resolve('work/attachment-formats-')),host=new Backend(root,data,'Trismegistus/Test/'+path.basename(data),()=>{});
execFileSync(host.python,['-c',`from PIL import Image; import sys; from pathlib import Path; p=Path(sys.argv[1]); a=Image.new('RGB',(40,30),'red'); b=Image.new('RGB',(40,30),'blue'); a.save(p/'sample.bmp'); a.save(p/'animated.gif',save_all=True,append_images=[b]); a.save(p/'long.pdf',save_all=True,append_images=[b]*20)`,data],{windowsHide:true});
const add=async(name:string,bytes:Uint8Array)=>saveAttachment(path.join(data,'attachments'),'chat',name,bytes,file=>host.host('attachment_prepare',{file,name}),()=>{});
const bmp=await add('sample.bmp',await fs.readFile(path.join(data,'sample.bmp')));
assert.equal(bmp.kind,'image');assert.equal((await attachmentContent(path.join(data,'attachments'),'chat',[bmp],true))[1].source.media_type,'image/png');
// Any file gets in (Koan, TRIS-TODO 1.2): what cannot be shown inline is saved and named for copy_chat_file.
const saved=async(name:string,bytes:Uint8Array)=>{const item=await add(name,bytes);assert.equal(item.kind,'file');const parts=await attachmentContent(path.join(data,'attachments'),'chat',[item]);assert.match(parts[1].text,new RegExp('not shown inline.*copy_chat_file \\(ID upload:'+item.id));return item;};
for(const name of ['animated.gif','long.pdf'])await saved(name,await fs.readFile(path.join(data,name)));
await saved('broken.pdf',Buffer.from('%PDF-broken'));
await saved('large.txt',Buffer.alloc(1024*1024+1,65));
assert.equal((await add('video.mp4',Buffer.from([0,0,0,24,102,116,121,112]))).kind,'video');
await saved('sound.wav',Buffer.from([0,0,0,24,102,116,121,112]));
// Previews keep the real reason.
for(const [name,expected] of [['animated.gif',/Animated images/],['long.pdf',/up to 20 pages/]] as const){const item=await saved(name,await fs.readFile(path.join(data,name)));await assert.rejects(host.host('attachment_prepare',{file:path.join(data,'attachments',item.id,'source'),name,strict:true}),expected);}
const text=await add('日本語.ts',Buffer.from('const word = "東京";\n'));
assert.match(JSON.stringify(await attachmentContent(path.join(data,'attachments'),'chat',[text])),/東京/);
await assert.rejects(host.host('attachment_prepare',{file:path.join(data,'sample.bmp'),name:'outside.bmp'}),/Invalid attachment location/);
console.log('PASS bundled PDF renderer, complete-page limit, image transcoding, other files saved and named, preview errors kept, Unicode text and source ownership: '+data);
