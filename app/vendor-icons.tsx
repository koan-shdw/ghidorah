// Real vendor logos on the supplier rows (W, PLAN 1b), from @lobehub/icons-static-svg@1.95.1 (MIT). Only these files
// are bundled. They are fixed files from the pinned package, drawn inline so a one-colour logo takes the text colour.
import React from 'react';
import alibaba from '../assets/vendor-icons/alibabacloud-color.svg';
import anthropic from '../assets/vendor-icons/anthropic.svg';
import deepseek from '../assets/vendor-icons/deepseek-color.svg';
import gemini from '../assets/vendor-icons/gemini-color.svg';
import grok from '../assets/vendor-icons/grok.svg';
import kimi from '../assets/vendor-icons/kimi-color.svg';
import minimax from '../assets/vendor-icons/minimax-color.svg';
import mistral from '../assets/vendor-icons/mistral-color.svg';
import nous from '../assets/vendor-icons/nousresearch.svg';
import openai from '../assets/vendor-icons/openai.svg';
import openrouter from '../assets/vendor-icons/openrouter.svg';
import vertex from '../assets/vendor-icons/vertexai-color.svg';
import xai from '../assets/vendor-icons/xai.svg';
import zai from '../assets/vendor-icons/zai.svg';

const icons:Record<string,string>={deepseek,openai,anthropic,alibaba,nous,'openrouter-api':openrouter,minimax,'minimax-cn':minimax,'minimax-oauth':minimax,mistral,'openai-api':openai,gemini,vertex,xai,'xai-oauth':grok,'kimi-coding':kimi,zai};
export function VendorIcon({id}:{id:string}){
 const svg=icons[id];
 return svg?<span className="vendor-icon" aria-hidden="true" dangerouslySetInnerHTML={{__html:svg}}/>:<span className="vendor-icon vendor-letter" aria-hidden="true">{id[0]?.toUpperCase()}</span>;
}
