import fs from 'node:fs';
import path from 'node:path';

// Delete what a passing test run added to work\ (never the desktop test logs). A file still held open is reported, not fatal.
export function removeNew(work,before){
  for(const name of fs.readdirSync(work))if(!before.has(name)&&name!=='desktop-tests'){
    try{fs.rmSync(path.join(work,name),{recursive:true,force:true,maxRetries:3});}
    catch(error){console.warn('Kept '+name+': '+error.message);}
  }
}
