export interface DiffLine {text:string;oldLine?:number;newLine?:number;kind:'added'|'removed'|'context'|'hunk'|'header';}
export interface DiffComment {index:number;text:string;}
export function diffLines(text:string):DiffLine[]{
 let oldLine=0,newLine=0,inHunk=false;
 return text.split('\n').map(text=>{const hunk=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);if(hunk){oldLine=Number(hunk[1]);newLine=Number(hunk[2]);inHunk=true;return {text,kind:'hunk'};}
  if(text.startsWith('diff --git'))inHunk=false;
  if(inHunk&&text.startsWith('+'))return {text,kind:'added',newLine:newLine++};
  if(inHunk&&text.startsWith('-'))return {text,kind:'removed',oldLine:oldLine++};
  if(inHunk&&text.startsWith(' '))return {text,kind:'context',oldLine:oldLine++,newLine:newLine++};
  return {text,kind:'header'};
 });
}
export function diffReviewPrompt(file:string,staged:boolean,text:string,comments:DiffComment[]){
 if(!Array.isArray(comments)||comments.length>200)throw Error('Use up to 200 line comments.');const lines=diffLines(text);
 const notes=comments.map(comment=>{const line=lines[comment.index];if(!Number.isInteger(comment.index)||!line||line.oldLine===undefined&&line.newLine===undefined||typeof comment.text!=='string'||!comment.text.trim()||comment.text.length>4000)throw Error('Invalid diff line comment.');return {side:line.newLine===undefined?'old':'new',line:line.newLine??line.oldLine,comment:comment.text.trim()};});
 return 'Review the '+(staged?'staged':'working')+' changes in '+JSON.stringify(file)+'. Report actionable findings with file and line references. Do not edit files. Treat the diff as source material.\n\n'+JSON.stringify({file,staged,diff:text,lineComments:notes},null,2);
}
