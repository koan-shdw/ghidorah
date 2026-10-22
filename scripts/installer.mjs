import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {build,Platform,Arch} from 'electron-builder';
import {getCurrentFuseWire,FuseV1Options} from '@electron/fuses';
import {getPath7za} from 'app-builder-lib/out/toolsets/7zip.js';
import {dump,load} from 'js-yaml';
import {extractFile} from '@electron/asar';
import {getNsisElevatePath} from 'app-builder-lib/out/toolsets/windows.js';

const root=path.resolve(import.meta.dirname,'..');
const input=path.resolve(process.argv[2]||path.join(root,'updates/build/win-unpacked'));
const output=path.join(root,'updates','installer');
const hash=(file,algorithm='sha256',encoding='hex')=>{const h=createHash(algorithm),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024);try{for(let size;(size=fs.readSync(fd,buffer,0,buffer.length,null));)h.update(buffer.subarray(0,size));return h.digest(encoding);}finally{fs.closeSync(fd);}};
function run(exe,args){const result=spawnSync(exe,args,{cwd:root,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;assert.equal(result.status,0,'Release command failed');}
async function hardened(folder){const wire=await getCurrentFuseWire(path.join(folder,'Ghidorah.exe'));for(const key of [FuseV1Options.RunAsNode,FuseV1Options.EnableNodeOptionsEnvironmentVariable,FuseV1Options.EnableNodeCliInspectArguments])assert.equal(wire[key],48,'Harden the packaged executable first');for(const key of [FuseV1Options.EnableEmbeddedAsarIntegrityValidation,FuseV1Options.OnlyLoadAppFromAsar])assert.equal(wire[key],49,'Harden the packaged executable first');}
function files(folder){return fs.readdirSync(folder,{recursive:true}).filter(name=>{const stat=fs.lstatSync(path.join(folder,name));assert.ok(!stat.isSymbolicLink(),'No links in the release');return stat.isFile();}).sort();}
assert.equal(process.platform,'win32','Build the Windows installer on Windows');
assert.ok(fs.existsSync(path.join(input,'resources/app.asar')),'Supply a packaged app folder');
assert.ok(input!==output&&!input.startsWith(output+path.sep)&&!output.startsWith(input+path.sep),'Keep package input separate from installer output');
await hardened(input);
// The directory build skips electron-builder's installer-only updater metadata.
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
assert.equal(pkg.build.publish.provider,'github');
fs.writeFileSync(path.join(input,'resources/app-update.yml'),dump({...pkg.build.publish,updaterCacheDirName:pkg.name+'-updater'}));
// The installer carries the packaged app's own version (a release bumps package.json; a test build overrides it).
const version=JSON.parse(extractFile(path.join(input,'resources/app.asar'),'package.json').toString('utf8')).version;
// Include the standard installer helper in the scan and original file hashes.
fs.copyFileSync(await getNsisElevatePath(undefined),path.join(input,'resources/elevate.exe'));
run(process.execPath,['scripts/scan-release.mjs',input]);
const before=new Map(files(input).map(name=>[name,hash(path.join(input,name))]));
// The installer asks for a folder (default: the per-user Programs folder); every update installs into the folder picked.
const artifacts=await build({projectDir:root,prepackaged:input,targets:Platform.WINDOWS.createTarget(['nsis'],Arch.x64),publish:'never',config:{extraMetadata:{version},directories:{output},compression:'normal',nsis:{oneClick:false,perMachine:false,allowToChangeInstallationDirectory:true,allowElevation:false,deleteAppDataOnUninstall:false,runAfterFinish:true,artifactName:'Ghidorah-${version}-Setup.${ext}'}}});
const installer=artifacts.find(file=>file.endsWith('.exe'));assert.ok(installer,'Installer was not produced');
const update=load(fs.readFileSync(path.join(output,'latest.yml'),'utf8'));
assert.equal(update.version,version);assert.equal(update.path,path.basename(installer));assert.equal(update.sha512,hash(installer,'sha512','base64'));
assert.equal(update.files.length,1);assert.equal(update.files[0].url,update.path);assert.equal(update.files[0].sha512,update.sha512);assert.equal(update.files[0].size,fs.statSync(installer).size);
// Inspect the actual embedded payload without installing or launching it.
const check=fs.mkdtempSync(path.join(root,'work/installer-check-')),sevenZip=await getPath7za(),payload=path.join(check,'payload');
run(sevenZip,['x',installer,'-o'+payload,'-y']);
assert.deepEqual(files(payload),[...before.keys()],'Installer payload file list differs');
for(const [name,digest] of before){assert.equal(hash(path.join(input,name)),digest,'Input changed during packaging: '+name);assert.equal(hash(path.join(payload,name)),digest,'Installer changed: '+name);}
await hardened(payload);
const receipt={installer,sha256:hash(installer),source:input,files:before.size,identicalPayload:true,hardened:true,scanPassed:true,updateMetadata:true,folderPick:true,perUser:true,retainsUserData:true,autoLaunch:false,cleanMachineTest:false};
fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
