// Chromium resamples the microphone into the 16 kHz AudioContext before this processor.
class Microphone extends AudioWorkletProcessor {
 constructor(){super();this.frame=new Int16Array(1280);this.used=0;}
 process(inputs){
  const samples=inputs[0]?.[0];if(!samples)return true;
  for(const value of samples){const sample=Math.max(-1,Math.min(1,value));this.frame[this.used++]=sample<0?sample*32768:sample*32767;if(this.used===this.frame.length){this.port.postMessage(this.frame.buffer,[this.frame.buffer]);this.frame=new Int16Array(1280);this.used=0;}}
  return true;
 }
}
registerProcessor('trismegistus-microphone',Microphone);
