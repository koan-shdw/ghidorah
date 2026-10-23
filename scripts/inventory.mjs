import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute = promisify(execFile);
export const SCHEMA = 2;
export const CACHE = '.repo-map';
export const NOTES = 'REPO-MAP-NOTES.json';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const skips = new Set(['.git', CACHE, 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', 'coverage', 'vendor', 'third-party', 'runtime', 'work', 'target', '.next', '.cache', '.pytest_cache']);
const secret = /^(?:\.env(?:\..*)?|.*\.env|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|\.azure|\.gnupg|\.claude|\.codex|\.hermes|credentials(?:\..*)?|auth\.json|config\.ya?ml|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const textExtensions = new Set(['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.py','.rs','.go','.cs','.java','.c','.h','.cpp','.hpp','.rb','.php','.swift','.kt','.sh','.ps1','.vue','.svelte','.html','.css','.scss','.sql','.md','.mdx','.rst','.toml','.json','.yaml','.yml']);
export const allowed = name => !name.split('/').some(part => skips.has(part) || secret.test(part) || part.startsWith('release-')) && !['REPO-MAP.json', NOTES, 'repo-map.html'].includes(name) && textExtensions.has(path.posix.extname(name).toLowerCase()) && !/\.min\.[cm]?js$|(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock)/.test(name);
export function inside(root, file) {const relative = path.relative(root, file); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..'+path.sep);}
export async function safePath(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || /[\x00-\x1f:]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(name)) throw Error('Invalid repository-relative path.');
  let current = root;
  for (const part of name.split('/')) {current = path.join(current, part); const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw Error('Symlinks are excluded.');}
  if (!inside(root, await fs.realpath(current))) throw Error('Path leaves repository.');
  return current;
}
export async function inventory(root, options = {}) {
  root = await fs.realpath(root);
  if (!(await fs.stat(root)).isDirectory()) throw Error('Repository root must be a directory.');
  const limits = {files:20000, bytes:80_000_000, fileBytes:1_000_000, ...options.limits};
  let names = [], mode = 'filesystem', excluded = 0;
  const issues = [];
  try {
    const git = async args => (await execute('git', ['-C', root, ...args], {windowsHide:true, timeout:15000, maxBuffer:8_000_000})).stdout;
    const top = (await git(['rev-parse','--show-toplevel'])).trim();
    if (path.normalize(await fs.realpath(top)) !== path.normalize(root)) throw Error('Not the Git root');
    const deleted = new Set((await git(['ls-files','-z','--deleted'])).split('\0').filter(Boolean));
    names = (await git(['ls-files','-z','--cached','--others','--exclude-standard'])).split('\0').filter(name => name && !deleted.has(name));
    mode = 'git';
  } catch {
    const queue = ['']; let visited = 0;
    while (queue.length) {
      const relative = queue.shift();
      let entries;
      try {entries = await fs.readdir(path.join(root, relative), {withFileTypes:true});}
      catch {issues.push({path:relative || '.', reason:'unreadable directory'}); continue;}
      for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
        if (++visited > limits.files * 3) {issues.push({path:'.', reason:'inventory limit'}); queue.length = 0; break;}
        const name = relative ? relative+'/'+entry.name : entry.name;
        if (entry.isSymbolicLink() || secret.test(entry.name) || skips.has(entry.name) || entry.name.startsWith('release-')) {excluded++; continue;}
        if (entry.isDirectory()) queue.push(name);
        else if (entry.isFile()) names.push(name);
      }
    }
  }
  names = [...new Set(names)].sort();
  const files = []; let bytes = 0;
  for (const name of names) {
    if (!allowed(name)) {excluded++; continue;}
    if (files.length >= limits.files) {issues.push({path:'.',reason:'file limit'}); break;}
    try {
      const absolute = await safePath(root, name), stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      if (stat.size > limits.fileBytes || bytes + stat.size > limits.bytes) {issues.push({path:name,reason:'byte limit'}); continue;}
      const content = await fs.readFile(absolute);
      const after = await fs.stat(absolute);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) {issues.push({path:name,reason:'changed during scan'}); continue;}
      bytes += content.length;
      if (content.includes(0)) {issues.push({path:name,reason:'binary content'}); continue;}
      files.push({path:name, hash:hash(content), bytes:content.length, text:content.toString('utf8')});
    } catch {issues.push({path:name,reason:'missing, unreadable or linked file'});}
  }
  const fingerprint = hash(JSON.stringify({schema:SCHEMA, mode, files:files.map(f=>[f.path,f.hash]), issues}));
  return {root,files,fingerprint,issues,mode,excluded,bytes,scope:'Non-ignored source, documentation and manifests; excludes credentials, generated output, dependencies, assets and links. Non-Git folders use built-in exclusions (not .gitignore).'};
}
export async function readSaved(root) {
  try {const file = await safePath(root, CACHE+'/index.json'); if ((await fs.stat(file)).size > 40_000_000) return null; const map = JSON.parse(await fs.readFile(file,'utf8')); return map.schema === SCHEMA && Array.isArray(map.files) ? map : null;}
  catch {return null;}
}
export async function saveMap(root, map, text, html) {
  const directory = path.join(root, CACHE);
  await fs.mkdir(directory, {recursive:true});
  await safePath(root, CACHE);
  for (const [name, body] of [['index.json', JSON.stringify(map)], ['index.txt',text], ...(html?[['map.html',html]]:[])]) {
    const target = path.join(directory,name), temporary = path.join(directory, name+'.'+randomUUID()+'.tmp');
    try {await fs.writeFile(temporary, body+'\n', {flag:'wx'}); await fs.rename(temporary,target);}
    finally {await fs.rm(temporary,{force:true});}
  }
}
