import {validateBank} from './model-probe-engine.js';
export const LOCAL_BANK=Object.freeze({url:new URL('./modeltrace-bank.json',import.meta.url).href,sha256:'72a834bd7ef1bd057d6c48379aa77968af92c1324d38bd661f429729bff62928',label:'WhatsMyLLM v2026.10.1 · 本机内置',upstream:'https://whatsmyllm.com/data/bank/v2026.10.1.json'});
let cached;
export function loadProbeBank(){
 if(cached)return cached;
 cached=(async()=>{
  const r=await fetch(LOCAL_BANK.url,{credentials:'omit',cache:'no-cache'});if(!r.ok)throw Error(`内置库 HTTP ${r.status}`);
  const t=await r.text(),d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(t));
  const hash=[...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==LOCAL_BANK.sha256)throw Error('内置库校验失败');
  const bank=JSON.parse(t);validateBank(bank);return {bank,info:{source:LOCAL_BANK.label,sha256:hash,remote:false,models:bank.models.length}};
 })();cached.catch(()=>{cached=undefined;});return cached;
}
