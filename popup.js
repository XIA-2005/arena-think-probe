import './price-runtime.js';
import {formatPulse} from './billing.js';

const $=id=>document.getElementById(id);
// Standalone selection list; no host instance catalog or source switch.
const KEEP_MODELS=['GPT-5.4','GPT-5.5','GPT-5.6 Sol','GPT-5.6 Terra','GPT-5.6 Luna','GPT-6 Astra','GPT-6 Sol','GPT-6 Luna','Claude Haiku 4.5','Claude Sonnet 4.6','Claude Sonnet 5','Claude Sonnet 5.5','Claude Opus 4.6','Claude Opus 4.7','Claude Opus 4.8','Claude Opus 5','Claude Opus 5.5','Claude Fable 5.1','Kimi K2.6','Gemini 3.8 Flash','DeepSeek V4 Pro 0813','Qwen3.8 Max 0902'];
let currentManualModels=[];const keepModelBoxes=new Map();
function buildKeepModels(){
  const host=$('keep-models');host.replaceChildren();keepModelBoxes.clear();
  for(const name of KEEP_MODELS){
    const row=document.createElement('label');row.className='keep-model';
    const cb=document.createElement('input');cb.type='checkbox';cb.value=name;
    cb.addEventListener('change',()=>{
      const set=new Set(currentManualModels.map(n=>String(n).trim().toLowerCase()));
      if(cb.checked)set.add(name.toLowerCase());else set.delete(name.toLowerCase());
      currentManualModels=KEEP_MODELS.filter(n=>set.has(n.toLowerCase()));
      void message('AMP_PREFS_SET',{patch:{manualKeepModels:currentManualModels}});
    });
    const span=document.createElement('span');span.textContent=name;
    row.append(cb,span);keepModelBoxes.set(name,cb);host.append(row);
  }
}
let tabId=null,available=false,timer=null;

function agentUrl(value){try{const url=new URL(value);return url.origin==='https://arena.ai'&&/^\/(?:agent|work)(?:\/|$)/.test(url.pathname);}catch{return false;}}
function clock(iso){const date=iso?new Date(iso):null;return date&&Number.isFinite(date.getTime())?`${date.getMonth()+1}-${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`:'—';}

function render(state){
  if(!state)return;const samples=Number(state.samples)||0,draw=state.draw||{},prefs=state.prefs||{};
  $('progress').textContent=state.progress||'等待操作';
  $('run-quick').disabled=!available||state.running||samples>=3;
  $('run-precise').disabled=!available||state.running||samples>=3;
  $('stop').disabled=!state.running;
  $('clear').disabled=state.running||(!samples&&!state.result);
  $('run-quick').textContent=state.running?'运行中…':'快速识别 · 随机1题';
  $('run-precise').textContent=state.running?'运行中…':'三题核验 · 3题全问';
  $('append').disabled=!available||state.running||samples===0||samples>=3;
  $('append').textContent=samples>=3?'3 题已问完':`再补 1 题（已 ${samples}/3）`;
  if(state.result){
    const result=state.result;$('result').hidden=false;$('result').dataset.level=result.status;$('model').textContent=result.nearest.display_name;
    $('badge').textContent=globalThis.ArenaPriceRuntime.label(result.evidence);$('result-reason').textContent=result.evidence?.reason||'证据尚未整理';$('result').dataset.evidence=result.evidence?.status||'pending';
    $('metrics').textContent=`指纹 ${{clear:'清晰',close:'接近',weak:'弱匹配'}[result.status]||'未知'} · 拟合 ${Number(result.signals.fit).toFixed(3)} · 分离 ${Number(result.signals.separation).toFixed(3)} · 有效 ${result.used_outputs}/${samples}`;
    $('bank').textContent=`${result.bank_source} · ${result.bank_models} 个候选 · ${(result.probe_results||[]).map(p=>`${p.expected_count}题: ${p.display_name||"无效"}`).join(" / ")}`;
  }else $('result').hidden=true;
  if(document.activeElement!==$('rounds'))$('rounds').value=String(prefs.rounds??5);
  if(document.activeElement!==$('mode'))$('mode').value=String(prefs.mode||'precise');
  if(document.activeElement!==$('min-pulse'))$('min-pulse').value=String(prefs.minPulse??0);
   currentManualModels=(prefs.manualKeepModels||[]).slice();
   const keepSet=new Set(currentManualModels.map(n=>String(n).trim().toLowerCase()));
   for(const [name,cb] of keepModelBoxes){cb.checked=keepSet.has(name.toLowerCase());cb.disabled=!!state.running;}
   $('keep-only').checked=!!prefs.keepOnly;
   $('keep-only').disabled=!!state.running;
   $('keep-only').title='非目标候选须三题有效、无冲突才归档';
   $('think-mode').value=prefs.thinkMode||'archive_skip';
   $('think-mode').disabled=!!state.running;
  $('follow-up').checked=!!prefs.followUp;$('follow-up').disabled=!!state.running;
  $('draw-start').disabled=!available||state.running;
  $('draw-start').textContent=draw.running?'抽卡进行中…':state.running?'识别进行中…':'开始抽卡';
  $('draw-start').title=state.running?'当前任务正在运行，可先点击停止':'按当前轮数、模式和额度下限开始';
  for(const id of ['rounds','mode','min-pulse'])$(id).disabled=!available||state.running;
   $('mode').title='按当前题数识别；非目标候选须补齐三题核验';
  $('draw-stop').disabled=!draw.running;
  $('draw-diagnose').disabled=!available||state.running;
  $('draw-progress').textContent=draw.note||'每轮先发随机码暖场等回复，再发送指纹探针；思维链按所选模式处理。';
  $('keep-summary').textContent=`面板勾选 ${currentManualModels.length} 个；${prefs.keepOnly?'非目标候选在三题有效、无冲突后归档':'未开启按模型归档'}`;
  $('draw-results').replaceChildren(...(draw.results||[]).slice(0,6).map(entry=>{
    const row=document.createElement('div'),left=document.createElement('span'),right=document.createElement('b');
    left.textContent=`${entry.round}. ${entry.label}`;right.textContent=entry.deleted?'已归档':entry.svgSent?'已发SVG':entry.retention||entry.verdict;row.append(left,right);return row;
  }));
  $('timeline').textContent=globalThis.ArenaPriceRuntime.formatTimeline(state.timeline)||'读取费用后显示，未读取。';
  $('cost-enable').disabled=state.running;
  $('price-refresh').disabled=state.running||!state.sessionId;
  $('price-note').textContent=globalThis.ArenaPriceRuntime.formatPrice(state.price);$('price-note').style.whiteSpace='pre-line';
  $('balance-value').textContent=state.balanceLoading?'读取中…':typeof state.balance?.pulse==='number'?formatPulse(state.balance.pulse):'—';
  $('balance-note').textContent=state.balanceError||(state.balance?.refreshedAt?`每日额度剩余 · 下次重置 ${clock(state.balance.refreshedAt)}`:'额度来自 arena.ai/api/me/pulse（百分比）');
}
async function message(type,extra={}){
  if(!available||!Number.isInteger(tabId))return null;
  try{const state=await chrome.tabs.sendMessage(tabId,{type,...extra});render(state);return state;}
  catch{available=false;$('unavailable').hidden=false;$('controls').hidden=true;return null;}
}
$('run-quick').addEventListener('click',()=>void message('AMP_RUN_QUICK'));
$('run-precise').addEventListener('click',()=>void message('AMP_RUN_PRECISE'));
$('append').addEventListener('click',()=>void message('AMP_RUN_APPEND'));
$('stop').addEventListener('click',()=>void message('AMP_STOP'));
$('clear').addEventListener('click',()=>void message('AMP_CLEAR'));
$('draw-start').addEventListener('click',()=>void message('AMP_DRAW_START',{rounds:Number($('rounds').value),patch:{mode:$('mode').value,minPulse:Number($('min-pulse').value)}}));
$('draw-stop').addEventListener('click',()=>void message('AMP_DRAW_STOP'));
$('draw-diagnose').addEventListener('click',()=>void message('AMP_DIAGNOSE'));
$('cost-enable').addEventListener('click',()=>void message('AMP_COST_ENABLE'));
$('price-refresh').addEventListener('click',()=>void message('AMP_PRICE_REFRESH'));
$('balance-refresh').addEventListener('click',()=>void message('AMP_BALANCE_REFRESH'));
for(const [id,key] of [['rounds','rounds'],['min-pulse','minPulse']]){
  $(id).addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{[key]:Number($(id).value)}}));
}
$('mode').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{mode:$('mode').value}}));
$('think-mode').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{thinkMode:$('think-mode').value}}));
$('keep-only').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{keepOnly:$('keep-only').checked}}));
$('follow-up').addEventListener('change',()=>void message('AMP_PREFS_SET',{patch:{followUp:$('follow-up').checked}}));
buildKeepModels();

try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});tabId=tab?.id??null;available=Number.isInteger(tabId)&&agentUrl(tab?.url);
  $('unavailable').hidden=available;$('controls').hidden=!available;
  if(available){await message('AMP_STATUS');timer=setInterval(()=>void message('AMP_STATUS'),1000);}
}catch{$('unavailable').hidden=false;$('controls').hidden=true;}
window.addEventListener('unload',()=>clearInterval(timer));
