// app/main.ts and the area files split out of it (SPLIT-PLAN), read as one source so a test finds a function by
// name wherever it lives.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export function mainSource(file=path.join('app','main.ts')){
 const dir=path.join(path.dirname(file),'main'),areas=fs.existsSync(dir)?fs.readdirSync(dir).filter(name=>name.endsWith('.ts')).sort().map(name=>fs.readFileSync(path.join(dir,name),'utf8')):[];
 // A test runs one function's text on its own, so the export word that only links the files is left out.
 const text=[fs.readFileSync(file,'utf8'),...areas].join('\n').replace(/^export (?=(?:async )?function |const |let )/gm,'');
 return ts.createSourceFile('main.ts',text,ts.ScriptTarget.Latest,true);
}
