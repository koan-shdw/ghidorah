// Settings pages added by the finish plan: Always on, Claude Code, Security. The wizard reuses them.
import React from 'react';
import type {Snapshot} from './types';
import {ChoiceMenu,Switch} from './kit';
import {SettingsCard} from './settings-dialog';
import {LIVE_VOICES} from './gemini-voice-settings';
import {stayAwakeChoices} from './always-on';
import {PRESETS,type Schedule} from './routines';
import {healthOf} from './availability';
import {rotationRows} from './key-rotation';
import {destinations} from './publishing-names';

type Call=(method:string,args?:any)=>Promise<any>;

// Connections rows: a health dot for each connected supplier, read like the model pill dots.
export function SupplierDot({connected,status}:{connected?:boolean;status?:string}){return connected?<span className={'health-dot '+healthOf(status)} aria-hidden="true"/>:null;}

export function AlwaysOnSettings({state,call}:{state:Snapshot;call:Call}){
 const settings=state.alwaysOn;
 return <section className="always-on-settings"><h3>Always on</h3><SettingsCard title="Startup">
  <div className="connection-field"><span>Start with Windows</span><Switch checked={!!settings?.startWithWindows} ariaLabel="Start with Windows" label={settings?.startWithWindows?'On':'Off'} onChange={()=>void call('alwaysOn',{startWithWindows:!settings?.startWithWindows}).catch(()=>{})}/></div>
  <p className="hint">Starts hidden in the tray when you sign in to Windows.</p>
  </SettingsCard><SettingsCard title="Power"><StayAwake state={state} call={call}/></SettingsCard>
  <SettingsCard title="Notifications"><div className="connection-field"><span>Desktop notifications</span><Switch checked={settings?.desktopNotifications!==false} ariaLabel="Desktop notifications" label={settings?.desktopNotifications===false?'Off':'On'} onChange={()=>void call('alwaysOn',{desktopNotifications:settings?.desktopNotifications===false}).catch(()=>{})}/></div><p className="hint">When you are away from a chat, show finished work and requests needing your attention. Click a notification to return to that chat.</p><div className="connection-field"><span>Question and approval sound</span><Switch checked={settings?.questionSound!==false} ariaLabel="Question and approval sound" label={settings?.questionSound===false?'Off':'On'} onChange={()=>void call('alwaysOn',{questionSound:settings?.questionSound===false}).catch(()=>{})}/></div><p className="hint">Play a short sound once when Tris needs your answer or permission, including while you are in the chat.</p></SettingsCard>
 </section>;
}

// Also on the Remote page (his words: "option is remote settings").
export function StayAwake({state,call}:{state:Snapshot;call:Call}){
 return <><div className="connection-field"><span>Stay awake</span><ChoiceMenu label="Stay awake" value={state.alwaysOn?.stayAwake||'remote'} options={stayAwakeChoices} onChange={stayAwake=>void call('alwaysOn',{stayAwake}).catch(()=>{})}/></div>
  <p className="hint">Computer stays awake, screen still locks.{state.alwaysOn?.awake?' Awake now.':''}</p></>;
}

// Runs Claude Code's own sign-in; on the Anthropic panel and the Claude Code page.
export function ClaudeSignIn({state,call}:{state:Snapshot;call:Call}){
 if(state.claude?.status==='Claude Code not installed')return null;
 return <button className="primary" disabled={state.claude?.status==='Waiting for sign-in'} onClick={()=>void call('claudeLogin').catch(()=>{})}>{state.claude?.connected?'Switch account':'Sign in to Claude Code'}</button>;
}

export function ClaudeCodeSettings({state,call}:{state:Snapshot;call:Call}){
 const status=state.claude?.status||'Not checked',missing=status==='Claude Code not installed';
 return <section className="claude-code-settings"><h3>Claude Code</h3><SettingsCard title="Connection">
  <div className="connection-field"><span>Status</span><span className="supplier-status"><span className={'health-dot '+healthOf(status)} aria-hidden="true"/>{status}</span></div>
  {missing&&<p>Install Claude Code, then sign in with your Claude subscription.</p>}
  <div className="actions">{missing&&<button className="primary" onClick={()=>void call('link',{kind:'claude-install'}).catch(()=>{})}>Install Claude Code ↗</button>}<ClaudeSignIn state={state} call={call}/><button onClick={()=>void call('claudeCheck').catch(()=>{})}>{missing?'Check again':'Check Claude Code'}</button></div>
  <p className="hint">Claude turns use your installed Claude Code and its own sign-in.</p></SettingsCard>
 </section>;
}

export function SecuritySettings({state,call,openSupplier}:{state:Snapshot;call:Call;openSupplier:(id:string)=>void}){
 const rows=rotationRows(state),done=state.keyRotation||{};
 return <section className="security-settings"><h3>Rotate all keys</h3>
  <p>For each supplier: open its key page, make a new key, replace it here, then delete the old key at the supplier. Sign-ins: sign in again.</p>
  {rows.length?<ul className="rotation-list">{rows.map(row=><li key={row.id}>
   <label><input type="checkbox" aria-label={row.name+' rotated'} checked={!!done[row.id]} onChange={event=>void call('keyRotation',{id:row.id,done:event.target.checked}).catch(()=>{})}/><span className={'health-dot '+row.health} aria-hidden="true"/>{row.name}</label>
   <small>{done[row.id]?'Done '+new Date(done[row.id]).toLocaleDateString():row.status}</small>
   <div className="actions">{row.page&&<button onClick={()=>void call(row.page!.method,row.page!.args).catch(()=>{})}>Key page ↗</button>}<button onClick={()=>openSupplier(row.id)}>{row.signIn?'Sign in again':'Replace key'}</button></div>
  </li>)}</ul>:<p className="hint">No suppliers connected.</p>}
  {Object.keys(done).length>0&&<div className="actions"><button onClick={()=>void call('keyRotation',{reset:true}).catch(()=>{})}>Start over</button></div>}
 </section>;
}

// Settings, Publishing (4c): where pages go. Both destinations publish with git and his own sign-in.
export function PublishingSettings({state,call}:{state:Snapshot;call:Call}){
 const saved=state.publishing,[repository,setRepository]=React.useState(saved?.repository||''),[branch,setBranch]=React.useState(saved?.branch||'main'),[site,setSite]=React.useState(saved?.site||''),[error,setError]=React.useState('');
 const destination=saved?.destination||'cloudflare';
 return <section className="publishing-settings"><h3>Publishing</h3><SettingsCard title="Destination">
  <div className="connection-field"><span>Publish to</span><ChoiceMenu label="Publish to" value={destination} options={destinations} onChange={value=>{setBranch(value==='github'?'gh-pages':'main');void call('publishingSave',{destination:value,branch:value==='github'?'gh-pages':'main'}).catch(()=>{});}}/></div>
  <p>{destination==='github'?'Pages go to the Pages branch of the repository below; GitHub Pages serves them.':'Pages go to the repository below; a Cloudflare Pages project connected to it serves them.'} The app pushes with your own git sign-in. No token is stored.</p>
  </SettingsCard><SettingsCard title="Repository"><label>Repository<input aria-label="Publish repository" value={repository} placeholder="https://github.com/you/pages.git" onChange={event=>setRepository(event.target.value)}/></label>
  <div className="settings-form-grid"><label>Branch<input aria-label="Publish branch" value={branch} onChange={event=>setBranch(event.target.value)}/></label>
  <label>Site address<input aria-label="Site address" value={site} placeholder={destination==='github'?'https://you.github.io/pages':'https://pages-1a2.pages.dev'} onChange={event=>setSite(event.target.value)}/></label></div>
  <div className="actions"><button className="primary" onClick={()=>{setError('');void call('publishingSave',{repository,branch,site}).catch(problem=>setError(String(problem).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));}}>Save publishing</button></div>
  {error&&<p className="error" role="alert">{error}</p>}
  <p className="hint">Pages on pages.dev and github.io are public: anyone with the link can open them.</p></SettingsCard>
 </section>;
}

// Settings, Browser and computer: Screen control (FEATURE-SPECS 1). One switch for every model; the two programs ship
// with the app. Koan approves each app the first time a model touches it; the apps he allowed always are listed here.
export function BrowserSettings({state,call}:{state:Snapshot;call:Call}){
 const tools=state.browserTools,[error,setError]=React.useState('');
 const run=(method:string,args:any)=>{setError('');void call(method,args).catch(problem=>setError(String(problem).replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));};
 const missing=Object.values(tools?.programs||{}).some(row=>!row.installed);
 return <section className="browser-settings"><h3>Browser and computer</h3><SettingsCard title="Web research"><p>Every connected model can search and read public pages through Exa. Queries and requested URLs are sent to Exa; fetched text stays with the chat for citations and later reading.</p><p className="hint">Included without sign-in · rate limits apply.</p></SettingsCard>
  <SettingsCard title="Screen control"><div className="connection-field"><span>Screen control</span><Switch checked={!!tools?.screen} ariaLabel="Screen control" label={tools?.screen?'On':'Off'} onChange={()=>run('screenSettingsSave',{screen:!tools?.screen})}/></div>
   <p className="hint">Models can see and use apps on this PC and drive Chrome. The first time a model touches an app, it asks you. While it works on screen a bar at the top says so: press Esc or Stop to end it.</p>
   {!tools?.chrome&&<p className="hint">Install Google Chrome for the browser part.</p>}
   {missing&&<p className="hint">This install is missing its screen control programs ({Object.entries(tools?.programs||{}).filter(([,row])=>!row.installed).map(([name])=>name).join(', ')}).</p>}
   <div className="connection-field"><span>Claude models use my own Chrome</span><Switch checked={!!tools?.ownChrome} ariaLabel="Claude models use my own Chrome" label={tools?.ownChrome?'On':'Off'} onChange={()=>run('screenSettingsSave',{ownChrome:!tools?.ownChrome})}/></div>
   <p className="hint">Needs the Claude in Chrome extension; it lets Claude use sites you are signed in to.</p>
  </SettingsCard>
  <SettingsCard title="Apps you always allow">{tools?.apps?.length?tools.apps.map(app=><div className="connection-field" key={app}><span>{app}</span><button onClick={()=>run('screenAppRemove',{app})}>Remove</button></div>):<p className="hint">None yet. When a model asks to use an app, choose Always to add it here.</p>}</SettingsCard>
  {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}

// Remote (6a): your own Telegram bot reaches the app while you are away. The token goes to the vault and never
// comes back to this window.
export function RemoteSettings({state,call}:{state:Snapshot;call:Call}){
 const remote=state.remote,[pairing,setPairing]=React.useState<{secret:string;qr:string}|null>(null),[token,setToken]=React.useState(''),[owner,setOwner]=React.useState(remote?.owner||''),[error,setError]=React.useState('');
 const run=(method:string,args?:any)=>void call(method,args).then(()=>setError(''),failure=>setError(String(failure).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));
 const status=remote?.status==='running'?'Connected to Telegram.':remote?.status==='starting'?'Connecting to Telegram…':remote?.status==='failed'?remote.message:'Off.';
 return <section className="remote-settings"><h3>Remote</h3>
  <p className="hint">Message your own Telegram bot to give the app tasks while you are away. Only your user ID is listened to.</p>
  <SettingsCard title="Telegram connection"><label>Bot token<input type="password" autoComplete="off" aria-label="Bot token" placeholder={remote?.tokenSaved?'Saved':'From BotFather'} value={token} onChange={event=>setToken(event.target.value)}/></label>
  <div className="actions"><button disabled={!token.trim()} onClick={()=>{run('remoteSave',{token});setToken('');}}>Save token</button><button onClick={()=>void call('link',{kind:'botfather'}).catch(()=>{})}>Open BotFather ↗</button></div>
  <label>Your Telegram user ID<input aria-label="Your Telegram user ID" inputMode="numeric" value={owner} onChange={event=>setOwner(event.target.value)}/></label>
  <div className="actions"><button disabled={!owner.trim()||owner.trim()===remote?.owner} onClick={()=>run('remoteSave',{owner})}>Save ID</button></div>
  <p className="hint">Your numeric user ID. Telegram's @userinfobot tells you yours.</p>
  <div className="connection-field"><span>Telegram support</span><span className="settings-status">{remote?.installed?'Installed':remote?.installing?'Installing…':'Not installed'}</span></div>
  {!remote?.installed&&<div className="actions">{remote?.installing?<button onClick={()=>void call('remoteInstallCancel').catch(()=>{})}>Cancel</button>:<button onClick={()=>run('remoteInstall')}>Install Telegram support</button>}</div>}
  </SettingsCard><SettingsCard title="Remote access"><div className="connection-field"><span>Remote</span><Switch checked={!!remote?.enabled} ariaLabel="Remote" label={remote?.enabled?'On':'Off'} onChange={()=>run('remoteSwitch',{on:!remote?.enabled})}/></div>
  <p className="hint" role="status">{status}</p>
  {remote?.enabled&&<p className="hint">Messages go to {remote.target||'a new chat'}{remote.paused?', paused from Telegram':''}. Send /project on Telegram to switch.</p>}
  </SettingsCard><SettingsCard title="Code before risky actions">
  <p className="hint">Each approval asked from Telegram needs a fresh code from an authenticator app that makes counter-based codes: Google Authenticator, FreeOTP or Aegis. Microsoft Authenticator and Authy do not.</p>
  <div className="actions"><button onClick={()=>void call('remotePair').then(result=>{setPairing(result);setError('');},failure=>setError(String(failure)))}>{remote?.paired?'Pair again':'Pair an authenticator'}</button></div>
  {remote?.paired&&!pairing&&<p className="hint">Paired. Pairing again replaces the old code on every phone.</p>}
  {pairing&&<div className="remote-pairing"><img src={pairing.qr} width={220} height={220} alt="Pairing picture for your authenticator"/><p>Or type this key: <code>{pairing.secret}</code></p><button onClick={()=>setPairing(null)}>Done</button></div>}
  </SettingsCard><SettingsCard title="Power"><StayAwake state={state} call={call}/></SettingsCard>
  {!!remote?.alerts?.length&&<><h3>Recent remote tasks</h3><ul className="remote-alerts" aria-label="Recent remote tasks">{remote.alerts.map(alert=><li key={alert.id}><strong>{alert.title}</strong> {alert.body} <span className="hint">{new Date(alert.at).toLocaleTimeString()}</span></li>)}</ul></>}
  {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}

// Routines (6e): a prompt sent to a chat on a schedule, by the app itself.
const WEEKDAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function scheduleText(schedule:Schedule){
 if(schedule.kind==='cron')return 'Cron '+schedule.line;
 return schedule.preset==='hourly'?'Every hour at :'+schedule.time.slice(3):PRESETS[schedule.preset]+(schedule.preset==='weekly'?' on '+WEEKDAYS[schedule.day!]:'')+' at '+schedule.time;
}
export function RoutinesSettings({state,call}:{state:Snapshot;call:Call}){
 const chats=state.chats.filter(chat=>!chat.archived&&!chat.parentChatId);
 const [name,setName]=React.useState(''),[how,setHow]=React.useState<'hourly'|'daily'|'weekdays'|'weekly'|'cron'>('daily'),[time,setTime]=React.useState('09:00'),[day,setDay]=React.useState(1),[line,setLine]=React.useState('0 9 * * 1-5'),[chatId,setChatId]=React.useState(chats.at(-1)?.id||''),[prompt,setPrompt]=React.useState(''),[error,setError]=React.useState('');
 const save=()=>void call('routineSave',{name,chatId,prompt,schedule:how==='cron'?{kind:'cron',line}:{kind:'preset',preset:how,time,...(how==='weekly'?{day}:{})}}).then(()=>{setName('');setPrompt('');setError('');},failure=>setError(String(failure).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,'')));
 return <section className="routines-settings"><h3>Routines</h3>
  <p className="hint">The app sends a prompt to a chat on a schedule, as if you typed it. A run missed while the app was closed runs once when it starts.</p>
  {(state.routines||[]).length?<ul className="routine-list" aria-label="Routines">{state.routines!.map(routine=><li key={routine.id}>
   <strong>{routine.name}</strong> <span className="hint">{scheduleText(routine.schedule)} · {chats.find(chat=>chat.id===routine.chatId)?.title||'Missing chat'} · {routine.enabled&&routine.nextFiring?'next '+new Date(routine.nextFiring).toLocaleString():'off'}</span>
   {routine.error&&<span className="hint"> · {routine.error}</span>}
   <Switch checked={routine.enabled} ariaLabel={'Run '+routine.name} label={routine.enabled?'On':'Off'} onChange={()=>void call('routineSwitch',{id:routine.id,enabled:!routine.enabled}).catch(()=>{})}/>
   <button aria-label={'Delete '+routine.name} onClick={()=>void call('routineDelete',{id:routine.id}).catch(()=>{})}>Delete</button>
  </li>)}</ul>:<p className="hint">No routines yet.</p>}
  <SettingsCard title="New routine">
  <label>Name<input aria-label="Routine name" value={name} onChange={event=>setName(event.target.value)}/></label>
  <div className="settings-form-grid"><label>How often<select aria-label="How often" value={how} onChange={event=>setHow(event.target.value as typeof how)}>{Object.entries(PRESETS).map(([id,label])=><option key={id} value={id}>{label}</option>)}<option value="cron">Cron line</option></select></label>
  {how==='cron'?<label>Cron line<input aria-label="Cron line" value={line} onChange={event=>setLine(event.target.value)}/></label>:<label>{how==='hourly'?'Minute past the hour':'Time'}<input aria-label="Time" type="time" value={time} onChange={event=>setTime(event.target.value)}/></label>}
  {how==='weekly'&&<label>Day<select aria-label="Day" value={day} onChange={event=>setDay(Number(event.target.value))}>{WEEKDAYS.map((label,index)=><option key={label} value={index}>{label}</option>)}</select></label>}
  </div><label>Chat<select aria-label="Chat" value={chatId} onChange={event=>setChatId(event.target.value)}>{chats.map(chat=><option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
  <label>Prompt<textarea aria-label="Prompt" rows={3} value={prompt} onChange={event=>setPrompt(event.target.value)}/></label>
  <div className="actions"><button className="primary" disabled={!name.trim()||!prompt.trim()||!chatId} onClick={save}>Save routine</button></div></SettingsCard>
  {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}

import {modelLabel} from './models';
// Speech is shared by dictation and the voice helper.
const SPEECH_MODELS:Record<string,string>={'large-v3':'Large v3 · 3.1 GB','small':'Small · 0.5 GB',tiny:'Tiny · 78 MB · tests only'};
export function VoiceSettings({state,call}:{state:Snapshot;call:Call}){
 const voice=state.voice,[error,setError]=React.useState(''),[key,setKey]=React.useState(''),[free,setFree]=React.useState(false),[saving,setSaving]=React.useState(false);
 const fail=(failure:unknown)=>setError(String(failure).replace(/^Error: /,'').replace(/^Error invoking remote method 'app': (?:Error: )?/,''));
 const status=voice?.installing?'Installing…'+(voice.progress!=null?' '+Math.round(voice.progress*100)+'%':''):voice?.ready?'Installed':'Not installed';
 const save=(useGemini=false)=>{setError('');setSaving(true);void call('voiceFreeKey',{key,useGemini,freeTierConfirmed:free}).then(()=>{setKey('');setFree(false);}).catch(fail).finally(()=>setSaving(false));};
 return <section className="voice-settings"><SettingsCard title="Google voice · free tier">
  <div className="connection-field"><span>Gemini Live</span><span className="settings-status">{voice?.freeKeySaved?'Key saved · free tier confirmed by you':'Set up free voice'}</span></div>
  <p className="hint">Starts when you press Listen or use the wake word. Speech streams directly to Google, with no local speech model. Stops when idle or when the allowance is used up; there is no automatic fallback.</p>
  <p className="hint">Use a project marked Free tier in Google AI Studio. Google determines billing; Tris cannot verify or force the tier. Keep billing off for this project. Google may use free-tier audio and content to improve its products.</p>
  <button onClick={()=>void call('link',{url:'https://aistudio.google.com/api-keys'}).catch(fail)}>Open Google AI Studio ↗</button>
  <label>Free-tier API key<input aria-label="Google voice API key" type="password" autoComplete="off" value={key} placeholder={voice?.freeKeySaved?'Enter a replacement key':'Paste your free-tier key'} onChange={event=>setKey(event.target.value)}/></label>
  <label><input type="checkbox" checked={free} onChange={event=>setFree(event.target.checked)}/>I checked that this key’s project is on Free tier with billing off.</label>
  <div className="actions"><button className="primary" disabled={saving||!free||!key.trim()} onClick={()=>save()}>Save voice key</button>{state.apiProviders?.some(row=>row.provider==='gemini'&&row.connected)&&<button disabled={saving||!free} onClick={()=>save(true)}>Use connected Google key</button>}{voice?.freeKeySaved&&<button disabled={saving} onClick={()=>void call('voiceFreeDisconnect').catch(fail)}>Disconnect voice</button>}</div>
  </SettingsCard><SettingsCard title="Conversation voices">
  <div className="settings-form-grid"><div className="connection-field"><span>Voice helper</span><ChoiceMenu label="Voice helper voice" value={voice?.liveVoice||'Kore'} options={Object.fromEntries(Object.entries(LIVE_VOICES).filter(([name])=>name!==(voice?.liveReplyVoice||'Puck')))} onChange={liveVoice=>void call('voiceSettings',{liveVoice}).catch(fail)}/><small>Conversation and draft readback.</small></div><div className="connection-field"><span>Main model replies</span><ChoiceMenu label="Main model reply voice" value={voice?.liveReplyVoice||'Puck'} options={Object.fromEntries(Object.entries(LIVE_VOICES).filter(([name])=>name!==(voice?.liveVoice||'Kore')))} onChange={liveReplyVoice=>void call('voiceSettings',{liveReplyVoice}).catch(fail)}/><small>Answers from the models working in your chat.</small></div></div>
  <p className="hint">The helper reads your draft and destination aloud. A fresh spoken yes sends it to the chat; ordinary conversation stays in voice.</p>
  </SettingsCard><SettingsCard title="Local dictation · optional">  <p className="hint">The Dictate button transcribes on your computer. Google voice works without this download.</p>
  <div className="connection-field"><span>Speech model</span><ChoiceMenu label="Speech model" value={voice?.sttModel||'large-v3'} options={Object.fromEntries((voice?.models||['large-v3','small']).map(id=>[id,SPEECH_MODELS[id]||id]))} onChange={sttModel=>void call('voiceSettings',{sttModel}).catch(fail)}/></div>
  <div className="connection-field"><span>Status</span><span className="settings-status" role="status">{status}</span></div>
  <div className="actions">{voice?.installing?<button onClick={()=>void call('speechInstallCancel').catch(fail)}>Cancel</button>:<button className="primary" onClick={()=>{setError('');void call('speechInstall').catch(fail);}}>{voice?.ready?'Repair speech':'Install speech'}</button>}</div>
  </SettingsCard><SettingsCard title="Wake word"><p className="hint">Say your English wake phrase to open voice over the front chat. Listening pauses while voice is open. The microphone stays on while listening is enabled.</p>
  <label>Wake phrase<input aria-label="Wake phrase" defaultValue={voice?.wake.phrase||'Hey Hermes'} maxLength={80} onBlur={event=>void call('wakeSave',{phrase:event.target.value.trim()}).catch(fail)}/></label>
  <label><input type="checkbox" aria-label="Listen for wake word" checked={voice?.wake.enabled||false} disabled={voice?.wake.installing||!voice?.wake.installed} onChange={event=>void call('wakeSave',{enabled:event.target.checked}).catch(fail)}/>Listen for wake word</label><p role="status">{voice?.wake.installing?'Installing wake-word listening…':voice?.wake.status||'Off'}</p>
  <div className="actions">{voice?.wake.installing?<button onClick={()=>void call('wakeInstallCancel').catch(fail)}>Cancel wake install</button>:<button disabled={voice?.wake.enabled} onClick={()=>void call('wakeInstall').catch(fail)}>{voice?.wake.installed?'Repair wake-word listening':'Install wake-word listening · 17.6 MB model'}</button>}</div>
  </SettingsCard><details><summary>Microphone and room</summary><label>Quiet interval (milliseconds)<input aria-label="Voice quiet interval" type="number" min="240" max="2000" step="80" defaultValue={voice?.silenceMs||640} onBlur={event=>void call('voiceSettings',{silenceMs:Number(event.target.value)}).catch(fail)}/></label><label>Wait after speaking (milliseconds)<input aria-label="Voice echo delay" type="number" min="300" max="3000" step="100" defaultValue={voice?.echoDelay||800} onBlur={event=>void call('voiceSettings',{echoDelay:Number(event.target.value)}).catch(fail)}/></label><label>Microphone threshold<input aria-label="Voice microphone threshold" type="number" min="0.001" max="0.2" step="0.001" defaultValue={voice?.threshold||.015} onBlur={event=>void call('voiceSettings',{threshold:Number(event.target.value)}).catch(fail)}/></label></details>
  {error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
