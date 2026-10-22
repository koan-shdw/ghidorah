import {flipFuses,FuseVersion,FuseV1Options,getCurrentFuseWire} from '@electron/fuses';
import path from 'node:path';
const executable=path.resolve(process.argv[2]||'updates/build/win-unpacked/Ghidorah.exe');
await flipFuses(executable,{
 version:FuseVersion.V1,
 [FuseV1Options.RunAsNode]:false,
 [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
 [FuseV1Options.EnableNodeCliInspectArguments]:false,
 [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true,
 [FuseV1Options.OnlyLoadAppFromAsar]:true,
});
console.log('Packaged executable fuses:',await getCurrentFuseWire(executable));
