// Every stylesheet value comes from the tokens; see scripts/style-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {styleProblems} from '../scripts/style-check.mjs';

test('stylesheets use only tokens, defined variables and no new duplicate rules',()=>{
  assert.deepEqual(styleProblems(),[]);
});
