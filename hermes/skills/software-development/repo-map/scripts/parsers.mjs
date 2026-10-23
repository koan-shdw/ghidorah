import ts from 'typescript';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

export const ANALYZER = 'ts-'+ts.version+'-python-ast-v2';
export const isJS = file => /\.[cm]?[jt]sx?$/.test(file);
export function parseJS(file) {
  const tree = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) return {status:'parse-error', symbols:[],imports:[],diagnostic:ts.flattenDiagnosticMessageText(tree.parseDiagnostics[0].messageText,' ')};
  const symbols = [], imports = [];
  const line = node => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1;
  function visit(node, owner='') {
    const declaration = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isMethodDeclaration(node) || (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)));
    if (declaration && node.name) {
      const name = (owner?owner+'.':'')+node.name.getText(tree);
      const body = node.body || node.initializer?.body;
      const end = body ? body.getStart(tree) : Math.min(node.end, node.getStart(tree)+300);
      symbols.push({name,kind:ts.SyntaxKind[node.kind],line:line(node),endLine:tree.getLineAndCharacterOfPosition(node.end).line+1,signature:file.text.slice(node.getStart(tree),end).replace(/\s+/g,' ').slice(0,300)});
      owner = name;
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push({specifier:node.moduleSpecifier.text,line:line(node)});
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const arg = node.arguments[0];
      imports.push({specifier:arg && ts.isStringLiteral(arg)?arg.text:null,line:line(node)});
    }
    ts.forEachChild(node,child=>visit(child,owner));
  }
  visit(tree);
  return {status:'parsed',symbols,imports};
}
export async function parsePython(files, python='python') {
  if (!files.length) return {};
  return new Promise((resolve,reject)=>{
    const child = spawn(python, ['-I','-B',fileURLToPath(new URL('./python_ast.py',import.meta.url))], {windowsHide:true,stdio:'pipe'});
    let stdout='', stderr='', exceeded=false;
    const timer=setTimeout(()=>{exceeded=true;child.kill();},30000);
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>20_000_000){exceeded=true;child.kill();}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);if(code||exceeded)reject(Error('Python parser failed or exceeded limits: '+stderr));else try{resolve(JSON.parse(stdout));}catch(error){reject(error);}});
    child.stdin.end(JSON.stringify(files));
  });
}
export function resolveImports(files) {
  const known = new Set(files.map(f=>f.path)), edges=[], unresolved=[];
  const choose = candidates => [...new Set(candidates)].filter(c=>known.has(c));
  for (const file of files) for (const item of file.imports) {
    let candidates=[];
    const spec = item.specifier;
    if (spec === null) {unresolved.push({from:file.path,line:item.line,specifier:'<dynamic>',reason:'dynamic expression'});continue;}
    if (file.path.endsWith('.py')) {
      const base = item.level ? path.posix.join(path.posix.dirname(file.path), ...Array(Math.max(0,item.level-1)).fill('..'), spec.replaceAll('.','/')) : spec.replaceAll('.','/');
      candidates=choose([base+'.py',base+'/__init__.py']);
      // from . import helper: the imported names are the module candidates.
      if (!spec && item.names) candidates=choose(item.names.flatMap(n=>[base+'/'+n+'.py',base+'/'+n+'/__init__.py']));
    } else if (spec.startsWith('.')) {
      const base=path.posix.normalize(path.posix.join(path.posix.dirname(file.path),spec));
      candidates=choose([base]);
      if (!candidates.length) {
        const stem=base.replace(/\.(?:js|jsx|mjs|cjs)$/,'');
        candidates=choose(['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs'].flatMap(ext=>[stem+ext,base+'/index'+ext]));
      }
    }
    if (candidates.length === 1 || file.path.endsWith('.py') && !spec && candidates.length) {
      for (const to of candidates) edges.push({from:file.path,to,line:item.line,kind:'import',evidence:'AST + existing local path'});
    } else unresolved.push({from:file.path,line:item.line,specifier:spec,reason:candidates.length?'ambiguous local module':'external, alias or unresolved module'});
  }
  return {edges,unresolved};
}
