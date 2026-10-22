// The kit's parts render the classes and roles screens, styles and tests rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Button,Card,Chip,Dialog,Notice,SettingRow,StatusDot,Switch,Tabs,fileIcon} from '../app/kit';

const html=(element:React.ReactElement)=>renderToStaticMarkup(element);

test('buttons: variants keep their old hooks; icon-only buttons drop the text',()=>{
 assert.match(html(React.createElement(Button,{variant:'primary'},'Save')),/class="kit-button kit-primary primary"[^>]*>Save</);
 assert.match(html(React.createElement(Button,{variant:'danger'},'Delete')),/kit-danger danger/);
 const icon=html(React.createElement(Button,{iconOnly:true,icon:'close','aria-label':'Close'},'Dropped label'));
 assert.match(icon,/kit-icon-only/);assert.match(icon,/aria-label="Close"/);assert.doesNotMatch(icon,/Dropped label/);
 assert.match(icon,/type="button"/);
});

test('a switch says its state to assistive tech and calls back with the new state',()=>{
 const on=html(React.createElement(Switch,{checked:true,onChange:()=>{},label:'RLM'}));
 assert.match(on,/role="switch"/);assert.match(on,/aria-checked="true"/);assert.match(on,/kit-switch-track/);assert.match(on,/RLM/);
 let value:boolean|undefined;const element=Switch({checked:false,onChange:next=>{value=next;},label:'x'}) as React.ReactElement<any>;
 element.props.onClick();assert.equal(value,true);
});

test('dots, chips, cards, rows and notices carry their tone and structure',()=>{
 assert.match(html(React.createElement(StatusDot,{tone:'danger',label:'Sign in again'})),/kit-dot kit-tone-danger[^>]*role="img"[^>]*aria-label="Sign in again"/);
 assert.match(html(React.createElement(StatusDot,{tone:'ok'})),/aria-hidden="true"/);
 assert.match(html(React.createElement(Chip,{tone:'accent'},'master')),/kit-chip kit-tone-accent/);
 assert.match(html(React.createElement(Card,{title:'Appearance'},'x')),/<section class="kit-card"><h3>Appearance<\/h3>x<\/section>/);
 const row=html(React.createElement(SettingRow,{name:'Theme',description:'Five themes'},React.createElement('select')));
 assert.match(row,/kit-row-name">Theme<\/span><small>Five themes<\/small>/);assert.match(row,/kit-row-control"><select>/);
 assert.match(html(React.createElement(Notice,{tone:'danger',role:'alert'},'Failed')),/kit-notice kit-tone-danger" role="alert"/);
});

test('tabs mark the shown view',()=>{
 const tabs=html(React.createElement(Tabs<'a'|'b'>,{items:[{id:'a',label:'Files'},{id:'b',label:'Changes'}],value:'b',onChange:()=>{},label:'Workspace views'}));
 assert.match(tabs,/aria-pressed="false"[^>]*><span>Files/);assert.match(tabs,/aria-pressed="true"[^>]*><span>Changes/);
});

test('a dialog has a titled header with a close button, a body and an optional footer',()=>{
 const dialog=html(React.createElement(Dialog,{title:'Export chat',id:'export-title',className:'export-dialog',onClose:()=>{},footer:React.createElement(Button,{variant:'primary'},'Save ZIP')},React.createElement('p',null,'One ZIP')));
 assert.match(dialog,/<dialog class="kit-dialog kit-dialog-md export-dialog" aria-labelledby="export-title"/);
 assert.match(dialog,/<h2 id="export-title">Export chat<\/h2>/);assert.match(dialog,/aria-label="Close"/);
 assert.match(dialog,/kit-dialog-body"><p>One ZIP<\/p>/);assert.match(dialog,/kit-dialog-foot/);
});

test('file icons follow the kind of file',()=>{
 assert.equal(fileIcon('notes.md'),'doc');assert.equal(fileIcon('app.tsx'),'code');assert.equal(fileIcon('shot.PNG'),'image');
 assert.equal(fileIcon('archive.zip'),'file');assert.equal(fileIcon('src',true),'folder');
});
