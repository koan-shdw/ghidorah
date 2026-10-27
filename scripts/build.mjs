import {build} from 'esbuild';
import {buildRepoMap} from './build-repo-map.mjs';
await buildRepoMap();
import {mkdir,copyFile,cp,readFile} from 'node:fs/promises';
// Ghidorah's Google sign-in app (Google's downloaded client JSON); git-ignored, so builds without it leave Google off.
const google=await readFile('google-client.json','utf8').then(text=>JSON.parse(text).installed,()=>null);
await mkdir('dist',{recursive:true});
await build({entryPoints:['app/main.ts'],outfile:'dist/main.cjs',bundle:true,platform:'node',format:'cjs',external:['electron','node-pty'],sourcemap:true});
await build({entryPoints:['app/preload.ts'],outfile:'dist/preload.cjs',bundle:true,platform:'node',format:'cjs',external:['electron']});
await build({entryPoints:['app/terminal-worker.ts'],outfile:'dist/terminal-worker.cjs',bundle:true,platform:'node',format:'cjs',external:['electron','node-pty']});
await build({entryPoints:['app/ui.tsx'],outfile:'dist/ui.js',bundle:true,platform:'browser',format:'esm',sourcemap:true,loader:{'.png':'dataurl','.svg':'text'},define:{'process.env.NODE_ENV':'"production"','process.env.GOOGLE_CLIENT':JSON.stringify(JSON.stringify(google&&{id:google.client_id,secret:google.client_secret}))}});
await copyFile('app/index.html','dist/index.html');
await copyFile('app/voice-worklet.js','dist/voice-worklet.js');
await mkdir('dist/licenses',{recursive:true});
await copyFile('assets/vendor-icons/LICENSE','dist/licenses/lobehub-icons.txt');

await cp('third-party/taag','dist/taag',{recursive:true});
