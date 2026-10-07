/* Pure prompt and transcript helpers shared by the Arena content controller. */
(() => {
  const DIRECT=' The current language model must complete this directly without tools, Python, code execution, calculators, search, APIs, or external random generators. Choose every position separately. Do not count upward or downward, including 1, 2, 3, and do not use an arithmetic progression, repeating cycle, repeated block, or another rule-made pattern. Accidental repetitions are valid. Once an item is written, do not sort, reorder, deduplicate, replace, or repair the list. Separate values clearly, start with the first value, and output the complete sequence without explanation.';
  const probes=Object.freeze([
    Object.freeze({id:'plain-1',expected_count:297,prompt:'For each of 297 positions, make one separate first-instinct choice of an integer from 1 to 355 inclusive.'+DIRECT}),
    Object.freeze({id:'plain-2',expected_count:315,prompt:'Provide exactly 315 whole-number choices between 1 and 355 inclusive, choosing each item separately as it comes to mind.'+DIRECT}),
    Object.freeze({id:'plain-3',expected_count:331,prompt:'Fill exactly 331 positions with integers from the closed interval [1, 355], making a separate immediate choice for every position.'+DIRECT}),
  ]);
  function parseRuns(text){
    const source=String(text||''),runs=[];let current=[],previousEnd=0;
    for(const match of source.matchAll(/\d+/g)){
      const separator=source.slice(previousEnd,match.index),value=Number(match[0]);
      if(current.length&&/\p{L}/u.test(separator)){runs.push(current);current=[];}
      if(value>=1&&value<=355)current.push(value);
      previousEnd=match.index+match[0].length;
    }
    if(current.length)runs.push(current);
    return runs;
  }
  function signatures(text){return new Set(parseRuns(text).filter(run=>run.length>=20).map(run=>run.join(',')));}
  function selectCandidate(text,before,expected){
    const minimum=Math.max(80,Math.ceil(expected*.55));
    const candidates=parseRuns(text).filter(run=>run.length>=minimum&&!before.has(run.join(','))&&run.length<=2000);
    candidates.sort((left,right)=>Math.abs(left.length-expected)-Math.abs(right.length-expected)||right.length-left.length);
    return candidates[0]||null;
  }
  // Only the API messages belonging to this probe may supply answer text.
  function probeAnswer(chat,context,expected){
    if(!chat)return {status:'waiting',error:'尚未读取到本轮回复'};
    const metadata=globalThis.ArenaPriceRuntime.messageMetadata(chat);
    const turn=globalThis.ArenaPriceRuntime.probeTurn(metadata,context,context.prompt);
    if(turn.error)return {status:'waiting',error:turn.error};
    if(turn.assistants.some(m=>m.hasReasoning))return {status:'reasoning'};
    const ids=new Set(turn.assistants.map(m=>m.id));
    const messages=chat.messages.filter(m=>ids.has(m.id));
    if(messages.some(m=>(m.parts||[]).some(p=>p.state==='streaming')))return {status:'waiting',error:'正文仍在生成'};
    const texts=messages.map(m=>({id:m.id,text:(Array.isArray(m.parts)?m.parts:[]).filter(p=>p.type==='text'&&typeof p.text==='string').map(p=>p.text).join('')})).filter(m=>m.text.trim());
    if(!texts.length)return {status:'waiting',error:'本轮尚无助手正文'};
    if(texts.length!==1)return {status:'invalid',error:'本轮有多条助手正文，无法唯一确定数字答案；未计分'};
    const text=texts[0].text.trim().replace(/^```(?:text)?\s*\n([\s\S]*?)\n```$/,'$1').trim();
    if(!/^[\d\s,，;；\[\]]+$/.test(text))return {status:'invalid',error:'本轮正文含解释、编号或非整数内容；未计分'};
    const values=(text.match(/\d+/g)||[]).map(Number);
    if(values.some(n=>!Number.isInteger(n)||n<1||n>355))return {status:'invalid',code:'out_of_range',error:'本轮数字超出 1–355；未计分'};
    if(values.length<Math.ceil(expected*.9)||values.length>Math.floor(expected*1.1))return {status:'invalid',error:`数量异常：预期 ${expected} 个，实收 ${values.length} 个（允许 ±10%）；未计分`};
    return {status:'ready',values,userId:turn.userId,assistantIds:[texts[0].id]};
  }
  const isTaskSuccessText=text=>{
    const value=String(text||'').replace(/\s+/g,' ').trim(),compact=value.replace(/[\s？?！!。．.：:，,、]/g,'');
    return /(?:此)?任务(?:是否)?成功(?:了)?吗/.test(compact)||/(?:was|is|did)\s+(?:this\s+)?task\s+(?:successful|succeed|a success)/i.test(value);
  };
  const isContinueWorkText=text=>{
    const value=String(text||'').replace(/\s+/g,' ').trim(),compact=value.replace(/[\s，,、：:。．.!！]/g,'');
    return /^(?:不|否)?继续工作(?:吧)?$/.test(compact)||/^(?:no[,.]?\s*)?(?:continue|keep)\s+(?:working|work)$/i.test(value);
  };
  const renameTitleForResult=(displayName,status)=>{
    const name=String(displayName||'').trim();
    return status==='weak'&&name&&!/[?？]$/.test(name)?`${name}?`:name;
  };
  /* v2.1.0 识别模式计划器（纯函数，便于测试）：
     quick   —— 从还没问过的题里随机抽 1 题；
     precise —— 依次补全剩余题目（最多 3 题，按 297/315/331 顺序）。
     used 为已发送过的题号数组；random 可注入，默认 Math.random。 */
  function planProbes(mode,used=[],random=Math.random){
    const indexes=probes.map((_,index)=>index);
    const sent=new Set((Array.isArray(used)?used:[]).filter(index=>indexes.includes(index)));
    const available=indexes.filter(index=>!sent.has(index));
    if(mode!=='quick')return available;
    if(!available.length)return [];
    const draw=Number(random());
    const pick=Math.min(available.length-1,Math.max(0,Math.floor((Number.isFinite(draw)?draw:0)*available.length)));
    return [available[pick]];
  }
  globalThis.ArenaProbeRuntime=Object.freeze({probes,parseRuns,signatures,selectCandidate,probeAnswer,isTaskSuccessText,isContinueWorkText,renameTitleForResult,planProbes});
})();
