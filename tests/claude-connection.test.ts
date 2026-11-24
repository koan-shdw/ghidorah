import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ClaudeConnection} from '../app/settings-pages';
import type {Snapshot} from '../app/types';

const render=(claude:Snapshot['claude'])=>renderToStaticMarkup(React.createElement(ClaudeConnection,{state:{claude} as Snapshot,call:async()=>{}}));

// Claude Code lives only in Connections > Anthropic (10-26); the panel shows what the old Claude Code page showed
// plus the plan and usage windows.
test('the Anthropic panel shows the plan and each usage window',()=>{
 const html=render({connected:true,status:'Signed in',plan:'max',windows:[{label:'5-hour',usedPercent:2,resetAt:null},{label:'Weekly',usedPercent:94,resetAt:'2026-10-27T07:00:00Z'}]});
 assert.match(html,/max plan/);assert.match(html,/5-hour: 2% used/);assert.match(html,/Weekly: 94% used · Resets /);
 assert.match(html,/Switch account/);assert.doesNotMatch(html,/Install Claude Code/);
});

test('a missing usage answer says so; a missing Claude Code offers the install',()=>{
 assert.match(render({connected:true,status:'Usage unavailable'}),/Usage windows unavailable/);
 const missing=render({connected:false,status:'Claude Code not installed'});
 assert.match(missing,/Install Claude Code ↗/);assert.match(missing,/Check again/);assert.doesNotMatch(missing,/Sign in to Claude Code|Usage windows/);
});

// Koan 11-24: Switch account did nothing and there was no sign-out. A signed-in panel offers both; a sign-in still
// waiting on its browser page says so and offers Cancel instead of a button that does nothing.
test('a signed-in panel offers Sign out; a waiting sign-in offers Cancel',()=>{
 const signedIn=render({connected:true,status:'Signed in'});
 assert.match(signedIn,/Switch account/);assert.match(signedIn,/>Sign out</);assert.doesNotMatch(signedIn,/Cancel sign-in/);
 const waiting=render({connected:true,status:'Signed in',signingIn:true});
 assert.match(waiting,/Cancel sign-in/);assert.match(waiting,/Finish signing in on the Anthropic page/);assert.doesNotMatch(waiting,/Switch account|>Sign out</);
 const signedOut=render({connected:false,status:'Claude Code is signed out'});
 assert.match(signedOut,/Sign in to Claude Code/);assert.doesNotMatch(signedOut,/>Sign out</);
});
