import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Question} from '../app/question';
import {readQuestions,questionResult,nativeQuestionAnswer} from '../app/questions';

test('questions preserve choices and custom answers, validate every answer, and render selectable controls',()=>{
 const single={question:'Continue?',choices:['Go (Recommended)','Wait']};
 assert.equal(readQuestions(single)[0].qid,'single');
 assert.deepEqual(questionResult(single,{single:'  My own answer  '}),{answer:'My own answer'});
 const batch={questions:[{qid:'q0',question:'Which?',choices:['A','B'],multi_select:true},{qid:'q1',question:'Why?'}]};
 assert.equal(readQuestions(batch)[0].multi,true);
 assert.deepEqual(questionResult(batch,{q0:'["A","B"]',q1:'Both help',extra:'ignored'}),{answers:{q0:'["A","B"]',q1:'Both help'}});
 assert.throws(()=>questionResult(batch,{q0:'["A"]',q1:' '}));
 assert.throws(()=>questionResult(single,{single:42}));
 assert.throws(()=>questionResult({questions:[]},{}));
 assert.equal(nativeQuestionAnswer('["A","B"]'),'A, B');
 assert.equal(nativeQuestionAnswer('My remote answer'),'My remote answer');
 const html=renderToStaticMarkup(React.createElement(Question,{item:{id:'pending',params:single},call:async()=>{throw Error('Rendering must not answer.');}}));
 assert.match(html,/type="radio"[^>]*checked=""/);assert.match(html,/Something else/);assert.match(html,/Recommended/);assert.match(html,/Send answer/);
 const multi=renderToStaticMarkup(React.createElement(Question,{item:{id:'batch',params:batch},call:async()=>{}}));
 assert.match(multi,/type="checkbox"/);assert.match(multi,/textarea/);assert.match(multi,/disabled=""/);
});
