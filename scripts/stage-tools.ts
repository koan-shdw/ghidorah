// Puts the pinned screen control programs into runtime\tools, so the Tris installer ships them (Koan 2026-10-10:
// "yes and part of the installer"). Each is downloaded once from its pinned release and checked by hash.
// Usage: node --import tsx scripts/stage-tools.ts
import path from 'node:path';
import {installProgram,installedProgram,programs,type ToolProgram} from '../app/browser-tools';

const runtime=path.resolve(import.meta.dirname,'..','runtime');
for(const program of Object.keys(programs) as ToolProgram[]){
 if(installedProgram(runtime,program)){console.log(program+' '+programs[program].version+' already staged');continue;}
 await installProgram(runtime,program,status=>console.log(program+': '+status));
}
