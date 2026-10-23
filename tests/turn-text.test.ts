import test from 'node:test';
import assert from 'node:assert/strict';
import {finalText} from '../app/turn-text';

test('an empty final Hermes message keeps the streamed text; interim commentary is kept (audit 5.3)',()=>{
 assert.equal(finalText('','Streamed answer.'),'Streamed answer.');
 assert.equal(finalText('Final answer.','Final answer.'),'Final answer.');
 assert.equal(finalText('Final answer.','I will read the file.\n\nFinal answer.','I will read the file.'),'I will read the file.\n\nFinal answer.');
 assert.equal(finalText('Final answer.','Final answer.','I will read the file.'),'I will read the file.\n\nFinal answer.');
});
