// Koan's curated Skills Hub picks, from "9 Claude Skills I Use Every Single Day" (Dubibubi), in the video's order.
// Install targets use the existing reviewed flows: a GitHub plugin repository, or a pinned GitHub skill folder.
// Hairline is Koan's own addition after the video's list.
// Icons are the repositories' own, shrunk to 128 px; sources and hashes in third-party/skill-icons.md.
import caveman from './skill-icons/caveman.png';
import potetoMode from './skill-icons/poteto-mode.png';
import ponytail from './skill-icons/ponytail.png';
import hyperframes from './skill-icons/hyperframes.png';
import impeccable from './skill-icons/impeccable.png';
import agentReach from './skill-icons/agent-reach.png';
import openDesign from './skill-icons/open-design.png';
export type SkillInstall={kind:'repository';repository:string}|{kind:'skill';identifier:string};
export interface SkillPick {name:string;rank:string;repo:string;path?:string;blurb:string;icon?:string;install?:SkillInstall;note?:string;}

export const skillPicks:SkillPick[]=[
 {rank:'#9',name:'Caveman',repo:'JuliusBrussee/caveman',icon:caveman,blurb:'Cuts tokens by having the agent talk like a caveman.',install:{kind:'repository',repository:'JuliusBrussee/caveman'},note:'Hermes’s code scanner rates it dangerous, so installing is blocked. The review shows what it found.'},
 {rank:'#8',name:'Poteto Mode',repo:'cursor/plugins',icon:potetoMode,path:'pstack/skills/poteto-mode',blurb:'The pstack way of working: understand, design, build, verify.',install:{kind:'skill',identifier:'github:cursor/plugins/pstack/skills/poteto-mode'}},
 {rank:'#7',name:'Vibe Security',repo:'raroque/vibe-security-skill',blurb:'Audits AI-written apps for common security holes.',note:'Uses shell features the skill converter does not support yet, so it cannot be installed here.'},
 {rank:'#6',name:'No AI Slop',repo:'petergyang/no-ai-slop',blurb:'Strips more than 20 AI writing habits from any text.',install:{kind:'skill',identifier:'github:petergyang/no-ai-slop/skills/no-ai-slop'}},
 {rank:'#5',name:'Ponytail',repo:'DietrichGebert/ponytail',icon:ponytail,blurb:'The laziest senior dev in the room: less code, simplest fix.',install:{kind:'repository',repository:'DietrichGebert/ponytail'}},
 {rank:'#4',name:'Matt Pocock’s Skills',repo:'mattpocock/skills',blurb:'Engineering skills straight from Matt Pocock’s own setup.',install:{kind:'repository',repository:'mattpocock/skills'}},
 {rank:'#3',name:'HyperFrames',repo:'heygen-com/hyperframes',icon:hyperframes,blurb:'Write HTML, render video. Built for agents.',note:'Cannot be installed on Windows yet: some of its files have paths longer than Windows allows.'},
 {rank:'#2',name:'Impeccable',repo:'pbakaus/impeccable',icon:impeccable,blurb:'A design language that makes the AI better at design.',install:{kind:'repository',repository:'pbakaus/impeccable'},note:'Hermes’s code scanner rates it dangerous, so installing is blocked. The review shows what it found.'},
 {rank:'#2',name:'Taste',repo:'Leonxlnx/taste-skill',blurb:'Gives the AI good taste and stops generic output.',install:{kind:'repository',repository:'Leonxlnx/taste-skill'}},
 {rank:'#1',name:'Autoresearch',repo:'karpathy/autoresearch',blurb:'AI agents running training research on a single GPU.',note:'A project to run, not a skill package. Open it on GitHub.'},
 {rank:'Mention',name:'Unlazy',repo:'Leonxlnx/unlazy',blurb:'Anti-laziness: splits a task into a depth tree so every part gets full effort.',install:{kind:'skill',identifier:'github:Leonxlnx/unlazy'}},
 {rank:'Mention',name:'AI Job Search',repo:'MadsLorentzen/ai-job-search',blurb:'A job search framework on Claude Code: scores postings, tailors CVs.',note:'A framework rather than one skill. Open it on GitHub.'},
 {rank:'Mention',name:'Agent Reach',repo:'Panniantong/Agent-Reach',icon:agentReach,path:'agent_reach/skill',blurb:'Lets the agent read and search Twitter, Reddit, YouTube and more.',install:{kind:'skill',identifier:'github:Panniantong/Agent-Reach/agent_reach/skill'},note:'Needs the Agent Reach command-line tool installed.'},
 {rank:'Mention',name:'Open Design',repo:'nexu-io/open-design',icon:openDesign,blurb:'An open-source design app, an alternative to Claude Design.',note:'A desktop app with its own installer. Open it on GitHub.'},
 {rank:'Koan',name:'Hairline',repo:'lucasmarkes/hairline',path:'skills/hairline-create',blurb:'Draws an isometric line figure for an idea, as one HTML file. Adds an Artwork button for the chat topic.',install:{kind:'skill',identifier:'github:lucasmarkes/hairline/skills/hairline-create'},note:'Checks figures with Node; the visual check also needs a browser.'},
];

// An installed package belongs to a pick when its pinned source is the pick's repository or skill folder.
export function pickInstalled(pick:SkillPick,installed:{repository?:string;enabled:boolean}[]){
 const source=pick.install?.kind==='skill'?pick.install.identifier.slice(7):pick.repo;
 return installed.find(item=>item.repository===source||item.repository===pick.repo&&pick.install?.kind==='repository');
}
