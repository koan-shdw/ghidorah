import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diffLines,diffReviewPrompt} from '../app/diff-review';
test('diff comments anchor added, removed and context lines across hunks',()=>{
 const text='diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n@@ -10 +11 @@\n-ten\n+eleven\n\\ No newline at end of file';const lines=diffLines(text);
 assert.equal(lines[2].newLine,undefined);assert.deepEqual([lines[4].oldLine,lines[4].newLine],[2,2]);assert.equal(lines[5].oldLine,3);assert.equal(lines[6].newLine,3);assert.equal(lines[7].newLine,4);assert.equal(lines[9].oldLine,10);assert.equal(lines[10].newLine,11);assert.equal(lines[11].newLine,undefined);
 const prompt=diffReviewPrompt('a',false,text,[{index:5,text:'Why remove this?'},{index:10,text:'Check this branch.'}]);assert.match(prompt,/"side": "old"/);assert.match(prompt,/"line": 11/);assert.throws(()=>diffReviewPrompt('a',false,text,[{index:2,text:'header'}]),/Invalid/);
});
