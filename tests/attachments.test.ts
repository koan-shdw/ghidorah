import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {saveAttachment,attachmentContent,attachmentMismatch,conversationAttachments,readsVideo} from '../app/attachments';
import {Store} from '../app/store';
import {handover} from '../app/history';
import type {Chat,Turn} from '../app/types';

test('attachment bytes are immutable and chat owned; both transports keep the image',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'tris-attachments-'));
 const image='data:image/png;base64,aGVsbG8=';
 const item=await saveAttachment(root,'chat-a','sample.png',Buffer.from('original'),async()=>({kind:'image',parts:[{type:'image_url',image_url:{url:image}}]}),()=>{});
 assert.deepEqual((await attachmentContent(root,'chat-a',[item]))[1],{type:'image_url',image_url:{url:image}});
 assert.deepEqual((await attachmentContent(root,'chat-a',[item],true))[1],{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}});
 await assert.rejects(attachmentContent(root,'chat-b',[item]),/another chat/);
 await fs.writeFile(path.join(root,item.id,'source'),'changed');await assert.rejects(attachmentContent(root,'chat-a',[item]),/changed on disk/);
 await assert.rejects(saveAttachment(root,'a','../other',Buffer.from('x'),async()=>({kind:'file',parts:[]}),()=>{}),/Invalid attachment name/);
});

test('draft acceptance and engine cursors retain precisely the owning attachment history',()=>{
 const store=new Store(':memory:'),chat=store.chat(store.project().id),other=store.chat(store.project().id);
 const item={id:'a',chatId:chat.id,name:'diagram.png',size:8,kind:'image' as const,sha256:'hash',contentHash:'hash'};
 store.update<Chat>('chat',chat.id,{attachments:[item]});const first=store.accept('first',chat.id,'Read this','gpt-6-astra');
 assert.deepEqual(first.attachments,[item]);assert.deepEqual(store.get<Chat>('chat',chat.id).attachments,[]);
 store.finishEngine(first.id,'hermes','session',{status:'completed'});
 const now=store.accept('now',chat.id,'Continue'),future=store.accept('future',chat.id,'Future');
 store.update<Turn>('turn',future.id,{attachments:[{...item,id:'future'}]});
 const foreign=store.accept('foreign',other.id,'Other');store.update<Turn>('turn',foreign.id,{attachments:[{...item,id:'foreign',chatId:other.id}]});
 const turns=store.all<Turn>('turn');
 assert.deepEqual(handover(turns,[],now,store.enginePosition(chat.id,'hermes')).attachments,[]);
 assert.deepEqual(handover(turns,[],now,store.enginePosition(chat.id,'claude')).attachments,[item]);
 assert.deepEqual(handover(turns,[],now,{...store.enginePosition(chat.id,'hermes'),uncertain:true}).attachments,[],'Hermes resumes its stored session, which has them');
 assert.deepEqual(handover(turns,[],now,{...store.enginePosition(chat.id,'hermes'),sessionId:null}).attachments,[item],'a new session gets them again');
 assert.deepEqual(conversationAttachments(turns,now),[item]);assert.match(attachmentMismatch([item],false)!,/image input/);assert.equal(attachmentMismatch([item],true),null);
 store.db.close();
});

test('videos need a Gemini model: other models get the connect-Gemini message',()=>{
 const video={id:'00000000-0000-4000-8000-000000000001',chatId:'c',name:'clip.mp4',size:4096,kind:'video' as const,sha256:'',contentHash:''};
 assert.equal(attachmentMismatch([video],true,'api:gemini:gemini-3.8-flash'),null);
 for(const model of ['deepseek-flash','gpt-6-astra','claude-code:opus','api:gemini:gemma-3-27b-it','api:vertex:gemini-3.8-flash'])assert.match(attachmentMismatch([video],true,model)!,/Videos go to Gemini/);
 assert.equal(readsVideo('api:gemini:gemini-3.6-flash'),true);assert.equal(readsVideo('api:openrouter-api:google/gemini-3.6-flash'),false);
});
