import test from 'node:test';import assert from 'node:assert/strict';
import {savedSpeechVoices} from '../app/speech-voices';

test('single-voice settings retain the helper and gain a distinct reply default',()=>{
 assert.deepEqual(savedSpeechVoices({}),{edgeVoice:'en-US-AriaNeural',replyVoice:'en-US-GuyNeural'});
 assert.deepEqual(savedSpeechVoices({edgeVoice:'en-US-GuyNeural'}),{edgeVoice:'en-US-GuyNeural',replyVoice:'en-US-AriaNeural'});
 assert.deepEqual(savedSpeechVoices({edgeVoice:'en-GB-SoniaNeural',replyVoice:'en-AU-WilliamNeural'}),{edgeVoice:'en-GB-SoniaNeural',replyVoice:'en-AU-WilliamNeural'});
 assert.deepEqual(savedSpeechVoices({edgeVoice:'removed',replyVoice:'unknown'}),{edgeVoice:'en-US-AriaNeural',replyVoice:'en-US-GuyNeural'});
});
