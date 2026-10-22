import test from 'node:test';
import assert from 'node:assert/strict';
import {atBottom} from '../app/follow-output';

test('the transcript follows only a reader who was at the bottom before the new output',()=>{
 // A 1083 px transcript in a 697 px view: its bottom is at 386.
 assert.equal(atBottom(1083,386,697),true,'at the bottom');
 assert.equal(atBottom(1083,300,697),true,'within the last 100 px');
 // Scrolled up to read; the scroll event has not arrived yet, but the live position already says so.
 assert.equal(atBottom(1083,25,697),false,'scrolled up');
 assert.equal(atBottom(0,0,697),true,'nothing shown yet');
});
