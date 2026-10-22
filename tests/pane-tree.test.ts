import test from 'node:test';
import assert from 'node:assert/strict';
import {group,split,normalize,removePane,insertAtGroup,movePane,allPaneIds,findGroupOfPane,setSplitWeights,growShares,type LayoutNode} from '../app/pane-tree';
import {treeFromSaved,readTree,chatPane,paneKind,WORKSPACE_PANE,reconcileTree,dropPosition} from '../app/pane-layout';

const shape=(node:LayoutNode|null):unknown=>!node?null:node.type==='group'?node.panes:{[node.orientation]:node.children.map(shape)};

test('opening and closing panes preserves unrelated tab placement; edge drops are explicit',()=>{
 const tree=split('row',[group(['main','chat:a'],{active:'chat:a',id:'tabs'}),group(['job:gone'],{id:'jobs'})]);
 const fallback=split('row',[group(['main']),group(['chat:a']),group(['workspace'])]);
 const next=reconcileTree(tree,fallback);assert.deepEqual(allPaneIds(next),['main','chat:a','workspace']);
 assert.equal(findGroupOfPane(next,'chat:a')?.id,'tabs');assert.equal(findGroupOfPane(next,'chat:a')?.active,'chat:a');
 assert.equal(reconcileTree(next,fallback),next,'unchanged inventory keeps the same tree');
 assert.equal(dropPosition(1,50,100,100),'left');assert.equal(dropPosition(99,50,100,100),'right');assert.equal(dropPosition(50,1,100,100),'top');assert.equal(dropPosition(50,99,100,100),'bottom');assert.equal(dropPosition(50,50,100,100),'center');
 assert.ok(readTree(next,()=>true));
});

test('persisted layouts reject ambiguous identities, cycles, depth, attribute types and overflowing weights',()=>{
 const a=group(['chat:a'],{id:'g1'}),b=group(['chat:b'],{id:'g2'}),exists=()=>true;
 for(const invalid of [split('row',[a,{...b,id:'g1'}]),{...a,minimized:'false'},{...a,tabStrip:7},split('row',[a,b],[Number.MAX_VALUE,Number.MAX_VALUE])])assert.equal(readTree(invalid,exists),null);
 const cycle:any=split('row',[],[1]);cycle.children.push(cycle);assert.equal(readTree(cycle,exists),null);
 let deep:LayoutNode=a;for(let i=0;i<40;i++)deep=split('row',[deep]);assert.equal(readTree(deep,exists),null);
 assert.ok(readTree(split('column',[a,b],[30,70]),exists));
});

test('the taken model: insert as a tab or a split, move, remove, and the tree stays canonical',()=>{
 let tree:LayoutNode|null=group(['chat:a'],{id:'g1'});
 tree=insertAtGroup(tree,'g1','chat:b','right');assert.deepEqual(shape(tree),{row:[['chat:a'],['chat:b']]});
 const second=findGroupOfPane(tree!,'chat:b')!.id;
 tree=insertAtGroup(tree!,second,'workspace','center');assert.deepEqual(shape(tree),{row:[['chat:a'],['chat:b','workspace']]});
 tree=movePane(tree!,'workspace',{groupId:'g1',pos:'bottom'});assert.deepEqual(shape(tree),{row:[{column:[['chat:a'],['workspace']]},['chat:b']]});
 tree=removePane(tree!,'chat:b');assert.deepEqual(shape(tree),{column:[['chat:a'],['workspace']]});
 assert.equal(removePane(group(['chat:a']),'chat:a'),null,'the last pane leaves nothing');
 assert.deepEqual(shape(normalize(split('row',[split('row',[group(['x']),group(['y'])]),group([])]))),{row:[['x'],['y']]},'nested same-way splits flatten; empty groups go');
 const weighted=setSplitWeights(split('row',[group(['x']),group(['y'])],undefined,'s1'),'s1',[30,70]);assert.deepEqual((weighted as any).weights,[30,70]);
});

test('the layout saved before panes becomes a tree; a stale or broken saved tree falls back',()=>{
 assert.equal(treeFromSaved({chatId:'',splitId:'',direction:'row',size:50}),null);
 assert.deepEqual(shape(treeFromSaved({chatId:'a',splitId:'',direction:'row',size:50})),['chat:a']);
 const twoUp=treeFromSaved({chatId:'a',splitId:'b',direction:'column',size:40})!;
 assert.deepEqual(shape(twoUp),{column:[['chat:a'],['chat:b']]});assert.deepEqual((twoUp as any).weights,[40,60]);
 const exists=(pane:string)=>['chat:a','chat:b',WORKSPACE_PANE].includes(pane);
 assert.deepEqual(shape(readTree(twoUp,exists)),{column:[['chat:a'],['chat:b']]});
 assert.equal(readTree(treeFromSaved({chatId:'a',splitId:'gone',direction:'row',size:50}),exists),null,'a pane that no longer exists');
 assert.equal(readTree({type:'group',id:'g',panes:['chat:a','chat:a'],active:'chat:a'},exists),null,'a pane twice');
 assert.equal(readTree({type:'split',id:'s'},exists),null,'not a tree');
 assert.equal(readTree('nonsense',exists),null);
 assert.deepEqual(paneKind(chatPane('a')),{kind:'chat',id:'a'});assert.deepEqual(paneKind('workspace'),{kind:'workspace'});assert.equal(paneKind('other'),null);
 assert.deepEqual(allPaneIds(twoUp),['chat:a','chat:b']);
});

// 10-20: his saved layout gave the chat 0.674 and the hidden workspace 0.464; flex-grow under 1 left a third empty.
test('the panes shown always fill their split, in proportion to their weights',()=>{
 assert.deepEqual(growShares([0.674,0.464],[true,false]),[1,0.464/0.674],'a hidden sibling gives up its share');
 const both=growShares([0.674,0.464],[true,true]);assert.ok(Math.abs(both[0]+both[1]-1)<1e-9);assert.ok(Math.abs(both[0]/both[1]-0.674/0.464)<1e-9);
 assert.deepEqual(growShares([1,1],[false,false]),[1,1],'nothing grows: weights stay as they are');
});
