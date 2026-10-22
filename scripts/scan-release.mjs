// Use the bundled Python standard library for ZIP, wheel, tar and ASAR inspection.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const python=path.join(root,'runtime/python/cpython-3.12.10-windows-x86_64-none/python.exe');
const result=spawnSync(python,['-I',path.join(root,'scripts/scan_release.py'),...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
if(result.error)console.error(result.error.message);
process.exit(result.status??1);
