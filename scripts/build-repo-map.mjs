import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export async function buildRepoMap(appRoot=path.resolve('.')){
 const skill=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../hermes/skills/software-development/repo-map');
 // The bundled TypeScript is Ghidorah's own (same version the skill pins); its licence ships beside the bundle.
 const typescript=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../node_modules/typescript');
 const output=path.join(appRoot,'dist/repo-map');
 await mkdir(output,{recursive:true});
 await build({entryPoints:[path.join(skill,'scripts/cli.mjs')],outfile:path.join(output,'cli.mjs'),bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module'; import {fileURLToPath as bundleFileURLToPath} from 'node:url'; import {dirname as bundleDirname} from 'node:path'; const require=createRequire(import.meta.url); const __filename=bundleFileURLToPath(import.meta.url); const __dirname=bundleDirname(__filename);"}});
 for(const name of ['python_ast.py','query.mjs','view.mjs'])await copyFile(path.join(skill,'scripts',name),path.join(output,name));
 await copyFile(path.join(typescript,'LICENSE.txt'),path.join(output,'TypeScript-LICENSE.txt'));
 await copyFile(path.join(typescript,'ThirdPartyNoticeText.txt'),path.join(output,'TypeScript-NOTICES.txt'));
 // Ship a self-contained skill too: copying it into a profile must not require npm.
 const packaged=path.join(appRoot,'dist/skills/repo-map');
 await mkdir(path.join(packaged,'scripts'),{recursive:true});
 await mkdir(path.join(packaged,'references'),{recursive:true});
 await copyFile(path.join(skill,'SKILL.md'),path.join(packaged,'SKILL.md'));
 await copyFile(path.join(skill,'LICENSE'),path.join(packaged,'LICENSE'));
 for(const name of ['schema.md','open-source-fit.md'])await copyFile(path.join(skill,'references',name),path.join(packaged,'references',name));
 for(const name of ['cli.mjs','python_ast.py','query.mjs','view.mjs','TypeScript-LICENSE.txt','TypeScript-NOTICES.txt'])await copyFile(path.join(output,name),path.join(packaged,'scripts',name));
}
