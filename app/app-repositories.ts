import fs from 'node:fs/promises';
import path from 'node:path';
import {protectedChatPath} from './chat-links';
import {workspacePath} from './workspace-files';

// Register existing app files in place. Relative paths retain workspace scope;
// absolute paths may point to another drive without changing any chat's root.
export async function existingAppPath(base:string|null,value:unknown,dataRoot:string){
 if(typeof value!=='string'||!value.trim()||/[\0\r\n]/.test(value))throw Error('Choose an existing app path.');
 const file=path.isAbsolute(value)?await fs.realpath(value):workspacePath(base,value);
 const privateRoot=await fs.realpath(dataRoot),relative=path.relative(privateRoot,file);
 if(protectedChatPath(value)||protectedChatPath(file)||relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw Error('Choose an app path outside private account and app data folders.');
 return file;
}
