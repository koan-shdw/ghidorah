import {cp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
// Local development distribution. Public redistribution/source obligations need
// resolution alongside the existing third-party artwork distribution gate.
const source=process.env.TRISMEGISTUS_POPPLER||path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler');
const manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
if(manifest.packageSpec!=='poppler=26.07.0=h6618ce5_3')throw Error('Expected the verified Poppler 26.07.0 Windows package.');
const target=path.resolve('runtime/poppler');await mkdir(target,{recursive:true});
await cp(path.join(source,'Library'),path.join(target,'Library'),{recursive:true});
const files={};
for(const file of await readdir(path.join(target,'Library'),{recursive:true,withFileTypes:true}))if(file.isFile()){
 const full=path.join(file.parentPath,file.name),relative=path.relative(target,full).replaceAll('\\','/');files[relative]=createHash('sha256').update(await readFile(full)).digest('hex');
}
await writeFile(path.join(target,'manifest.json'),JSON.stringify({...manifest,source:'conda-forge',files},null,2));
console.log(`Staged ${Object.keys(files).length} Poppler files with SHA-256 manifest`);
