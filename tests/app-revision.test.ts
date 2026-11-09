import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {appSummarySources,summaryRevision} from '../app/app-summary';
import {appTurnOwners} from '../app/saved-apps';
import {mainSource} from './fixtures/main-source';

const source=mainSource();
function main(name:string,env:Record<string,unknown>){
 let node:ts.Node|undefined;const visit=(n:ts.Node)=>{if(ts.isFunctionDeclaration(n)&&n.name?.getText(source)===name)node=n;ts.forEachChild(n,visit);};visit(source);assert.ok(node);
 return new Function(...Object.keys(env),ts.transpile(node.getText(source),{target:ts.ScriptTarget.ES2022})+';return '+name)(...Object.values(env));
}

// LAG 2026-11-09: the summary revision is the same hash as before, but hashed again only when a source row changed.
test('the app summary revision is hashed again only when a row it is made of changed',()=>{
  let hashed=0;
  const appRevision=main('appRevision',{appTurnOwners,summaryRevision,appSummarySources:(app:any,state:any)=>{hashed++;return appSummarySources(app,state);},revisionMemo:new Map()});
  const app:any={id:'app',name:'Ghidorah',stage:'beta',current:'Lag fix',ideas:'',planned:'',chatIds:['c1'],todos:[]};
  const turn=(text:string)=>({id:'t1',chatId:'c1',prompt:'Fix the lag',text,status:'completed',error:null,created:1,reasoning:'',model:'m',usage:null});
  const state=(text:string,title='Chat'):any=>({chats:[{id:'c1',title}],turns:[turn(text)],goals:[],approvals:[]});
  const first=appRevision(app,state('Done'));assert.equal(hashed,1);
  assert.equal(appRevision(app,state('Done')),first);assert.equal(hashed,1,'the same rows again: no second hash');
  assert.equal(first,summaryRevision(appSummarySources(app,state('Done'))),'the revision the summary was saved with');
  const longer=appRevision(app,state('Done, and more'));assert.notEqual(longer,first);assert.equal(hashed,2);
  const renamed=appRevision(app,state('Done, and more','Renamed'));assert.notEqual(renamed,longer);assert.equal(hashed,3);
  assert.notEqual(appRevision({...app,current:'Lag fiy'},state('Done, and more','Renamed')),renamed,'a note edit of the same length counts');assert.equal(hashed,4);
  assert.equal(appRevision(app,state('Done')),first);assert.equal(hashed,5,'one memo per app: earlier rows are hashed again');
});
