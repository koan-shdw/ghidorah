// npm test: the unit tests. The work\ folders they create are deleted when every test passes; a failing run keeps
// them as evidence (Koan, TRIS-TODO 1.8).
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {removeNew} from './work-cleanup.mjs';

const root=path.resolve(import.meta.dirname,'..'),work=path.join(root,'work');
fs.mkdirSync(work,{recursive:true});
const before=new Set(fs.readdirSync(work));
const {status}=spawnSync(process.execPath,['--import','tsx','--test',...process.argv.slice(2).length?process.argv.slice(2):['tests/*.test.ts']],{cwd:root,stdio:'inherit'});
if(status===0)removeNew(work,before);
process.exit(status??1);
