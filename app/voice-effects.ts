// The voice effects (Koan 2026-11-15): flat robot, whisper, ring machine, metal pipe, old computer and intercom.
// Every effect takes 24 kHz mono samples and returns the same number of samples; render() stacks them, each mixed in
// by its amount. The sums are the ones Koan heard on the samples and voice menu pages, checked there against scipy.
export const RATE=24000;
// The effects were tuned on Kokoro's raw output, which peaks near this; old computer and intercom depend on level.
const LEVEL=0.6;
// butter(4, [400, 2800], 'bandpass', fs=24000, output='sos'), from scipy.
const INTERCOM_SOS=[[0.004824343357716231,0.009648686715432462,0.004824343357716231,1.0,-1.1462445725404682,0.3709419392131974],
 [1.0,2.0,1.0,1.0,-1.2626464017080072,0.6742390247902301],[1.0,-2.0,1.0,1.0,-1.7821137820253985,0.7983469277963311],
 [1.0,-2.0,1.0,1.0,-1.927285350999603,0.938448783919227]];
export type EffectId='robot'|'whisper'|'ring'|'pipe'|'crush'|'intercom';
export type EffectSetting={amount:number;value:number};
type Samples=Float32Array|Float64Array;

const tables=new Map<number,{cos:Float64Array;sin:Float64Array}>();
function table(n:number){
 let t=tables.get(n);
 if(!t){t={cos:new Float64Array(n>>1),sin:new Float64Array(n>>1)};for(let k=0;k<n>>1;k++){t.cos[k]=Math.cos(2*Math.PI*k/n);t.sin[k]=-Math.sin(2*Math.PI*k/n);}tables.set(n,t);}
 return t;
}
/** Forward FFT in place; the length is a power of two. */
function fft(re:Float64Array,im:Float64Array){
 const n=re.length,t=table(n);
 for(let i=1,j=0;i<n;i++){
  let bit=n>>1;
  for(;j&bit;bit>>=1)j^=bit;
  j^=bit;
  if(i<j){let s=re[i];re[i]=re[j];re[j]=s;s=im[i];im[i]=im[j];im[j]=s;}
 }
 for(let len=2;len<=n;len<<=1){
  const half=len>>1,stride=n/len;
  for(let i=0;i<n;i+=len)for(let k=0;k<half;k++){
   const a=i+k,b=a+half,cr=t.cos[k*stride],ci=t.sin[k*stride];
   const xr=re[b]*cr-im[b]*ci,xi=re[b]*ci+im[b]*cr;
   re[b]=re[a]-xr;im[b]=im[a]-xi;re[a]+=xr;im[a]+=xi;
  }
 }
}
const plans=new Map<number,(re:Float64Array,im:Float64Array)=>void>();
/** A forward DFT of any length (Bluestein's method when the length is not a power of two). */
function plan(N:number){
 let run=plans.get(N);
 if(run)return run;
 if((N&(N-1))===0)run=fft;
 else{
  let M=1;
  while(M<2*N-1)M<<=1;
  const wr=new Float64Array(N),wi=new Float64Array(N);
  for(let n=0;n<N;n++){const a=Math.PI*((n*n)%(2*N))/N;wr[n]=Math.cos(a);wi[n]=-Math.sin(a);}
  const br=new Float64Array(M),bi=new Float64Array(M);
  br[0]=wr[0];bi[0]=-wi[0];
  for(let n=1;n<N;n++){br[n]=br[M-n]=wr[n];bi[n]=bi[M-n]=-wi[n];}
  fft(br,bi);
  const ar=new Float64Array(M),ai=new Float64Array(M);
  run=(re,im)=>{
   ar.fill(0);ai.fill(0);
   for(let n=0;n<N;n++){ar[n]=re[n]*wr[n]-im[n]*wi[n];ai[n]=re[n]*wi[n]+im[n]*wr[n];}
   fft(ar,ai);
   for(let k=0;k<M;k++){const r=ar[k]*br[k]-ai[k]*bi[k];ai[k]=-(ar[k]*bi[k]+ai[k]*br[k]);ar[k]=r;}
   fft(ar,ai);
   for(let n=0;n<N;n++){const cr=ar[n]/M,ci=-ai[n]/M;re[n]=cr*wr[n]-ci*wi[n];im[n]=cr*wi[n]+ci*wr[n];}
  };
 }
 plans.set(N,run);
 return run;
}
/** scipy's stft then istft: half a frame of silence at both ends, a Hann window, frames laid back over each other. */
function frames(x:Samples,N:number,hop:number,each:(re:Float64Array,im:Float64Array)=>void){
 const half=N>>1;
 let L=x.length+2*half;
 L+=(hop-((L-N)%hop))%hop;
 const pad=new Float64Array(L);
 pad.set(x,half);
 const win=new Float64Array(N);
 for(let n=0;n<N;n++)win[n]=0.5-0.5*Math.cos(2*Math.PI*n/N);
 const out=new Float64Array(L),norm=new Float64Array(L),re=new Float64Array(N),im=new Float64Array(N);
 for(let o=0;o+N<=L;o+=hop){
  for(let n=0;n<N;n++){re[n]=pad[o+n]*win[n];im[n]=0;}
  each(re,im);
  for(let n=0;n<N;n++){out[o+n]+=re[n]*win[n];norm[o+n]+=win[n]*win[n];}
 }
 const y=new Float32Array(x.length);
 for(let n=0;n<y.length;n++){const d=norm[half+n];y[n]=out[half+n]/(d>1e-10?d:1);}
 return y;
}
/** Every frame starts in step, so the voice holds one note. */
export function robot(x:Samples,note:number){
 const hop=Math.max(16,Math.floor(RATE/note)),N=hop*4,run=plan(N);
 return frames(x,N,hop,(re,im)=>{
  run(re,im);
  for(let k=0;k<N;k++){re[k]=Math.hypot(re[k],im[k]);im[k]=0;}
  run(re,im);
  for(let n=0;n<N;n++)re[n]/=N;
 });
}
/** The voice's breath without its note. The frame is a power of two. */
export function whisper(x:Samples,N:number){
 const hop=N>>2,h=N>>1;
 let seed=7;
 const random=()=>{seed=(seed+0x6D2B79F5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};
 return frames(x,N,hop,(re,im)=>{
  fft(re,im);
  for(let k=0;k<=h;k++){const m=Math.hypot(re[k],im[k]),a=2*Math.PI*random();re[k]=m*Math.cos(a);im[k]=-m*Math.sin(a);}
  im[0]=0;im[h]=0;
  for(let k=1;k<h;k++){re[N-k]=re[k];im[N-k]=-im[k];}
  fft(re,im);
  for(let n=0;n<N;n++)re[n]/=N;
 });
}
export function ring(x:Samples,hertz:number){
 const y=new Float32Array(x.length);
 for(let n=0;n<y.length;n++)y[n]=x[n]*Math.sin(2*Math.PI*hertz*n/RATE);
 return y;
}
export function crush(x:Samples,to:number,bits:number){
 const step=Math.max(1,Math.floor(RATE/to)),levels=Math.pow(2,bits)/2,y=new Float32Array(x.length);
 for(let n=0;n<y.length;n++)y[n]=Math.round(x[n-n%step]*levels)/levels;
 return y;
}
export function pipe(x:Samples,hertz:number,feedback=0.78){
 const delay=Math.max(1,Math.floor(RATE/hertz)),y=new Float32Array(x.length);
 for(let n=0;n<y.length;n++)y[n]=x[n]+(n>=delay?feedback*y[n-delay]:0);
 return y;
}
export function intercom(x:Samples,drive:number){
 const y=Float64Array.from(x);
 for(const [b0,b1,b2,,a1,a2] of INTERCOM_SOS){
  let z1=0,z2=0;
  for(let n=0;n<y.length;n++){const v=y[n],w=b0*v+z1;z1=b1*v-a1*w+z2;z2=b2*v-a2*w;y[n]=w;}
 }
 const out=new Float32Array(x.length);
 for(let n=0;n<out.length;n++)out[n]=Math.tanh(y[n]*drive);
 return out;
}

const peak=(x:Samples)=>{let m=0;for(let n=0;n<x.length;n++){const v=Math.abs(x[n]);if(v>m)m=v;}return m;};
const rms=(x:Samples)=>{let s=0;for(let n=0;n<x.length;n++)s+=x[n]*x[n];return Math.sqrt(s/Math.max(1,x.length));};
function scaled(x:Samples,gain:number){const y=new Float32Array(x.length);for(let n=0;n<y.length;n++)y[n]=x[n]*gain;return y;}
/** What the old computer's one slider means: 0 is mild, 100 is harsh. */
export function age(value:number){const t=value/100;return {bits:Math.round(8-5*t),to:Math.round(12000*Math.pow(0.25,t))};}

export const EFFECT_ORDER:EffectId[]=['robot','whisper','ring','pipe','crush','intercom'];
const RUN:Record<EffectId,(x:Float32Array,value:number)=>Float32Array>={
 robot:(x,v)=>robot(x,v),
 whisper:(x,v)=>whisper(x,128<<v),
 ring:(x,v)=>ring(x,v),
 pipe:(x,v)=>pipe(x,v),
 crush:(x,v)=>{const a=age(v);return crush(scaled(x,LEVEL),a.to,a.bits);},
 intercom:(x,v)=>intercom(scaled(x,LEVEL),v),
};
/** A clip through the stacked effects: brought to full level, each effect mixed in by its amount (0 to 100) at the
 * loudness of what went in, then set just under full level. */
export function render(clip:Samples,effects?:Partial<Record<EffectId,EffectSetting>>){
 let y=scaled(clip,1/Math.max(1e-6,peak(clip)));
 for(const name of EFFECT_ORDER){
  const effect=effects?.[name];
  if(!effect||!(effect.amount>0))continue;
  const wet=RUN[name](y,effect.value),mix=effect.amount/100,gain=rms(y)/Math.max(1e-9,rms(wet));
  const next=new Float32Array(y.length);
  for(let n=0;n<next.length;n++)next[n]=(1-mix)*y[n]+mix*gain*wet[n];
  y=next;
 }
 return scaled(y,0.89/Math.max(1e-6,peak(y)));
}
