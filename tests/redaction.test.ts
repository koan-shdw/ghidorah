import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SecretScrubber,redactPastedKeys} from '../app/redaction.ts';

test('numeric and boolean payloads remain valid when a short secret matches their JSON spelling',()=>{
 const scrub=new SecretScrubber();scrub.register('123');scrub.register('true');
 assert.deepEqual(scrub.value({count:123,ready:true,items:['123',123,'true'],note:'token 123'}),{count:123,ready:true,items:['[redacted]',123,'[redacted]'],note:'token [redacted]'});
});
test('active values, overlapping secrets and split chunks never disclose a credential',()=>{
 const scrub=new SecretScrubber();for(let i=0;i<80;i++)scrub.register('credential-'+String(i).padStart(3,'0')+'-opaque');
 scrub.register('secret-value');scrub.register('secret-value-long');
 const stream=scrub.stream();const text=stream('prefix secret-')+stream('value-long and credential-')+stream('000-opaque suffix',true);
 assert.equal(text,'prefix [redacted] and [redacted] suffix');
 assert.equal(scrub.text('credential-079-opaque'), '[redacted]');
});
test('newly pasted API key shapes are removed from saved drafts before connection',()=>{
  for(const key of ['sk-'+('a'.repeat(32)),'sk-proj-'+('b'.repeat(40))])assert.doesNotMatch(redactPastedKeys('Please use '+key),new RegExp(key));
  assert.equal(redactPastedKeys('Build the calculator.'),'Build the calculator.');
});
