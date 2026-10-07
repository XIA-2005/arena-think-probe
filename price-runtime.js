/* 价格仅作相容性检验。十进制定点整数避免浮点 gcd；不从最大因子猜模型。 */
(() => {
  const SCALE=14, UNIT=10n**8n;
  const fields=['outputTokensCostUsd','inputTokensCostUsd','cacheReadTokensCostUsd','cacheWriteTokensCostUsd'];
  const prices=Object.freeze([
    {id:'gpt-6-astra',out:50}, {id:'gpt-5.6-terra',out:12},
    {id:'claude-sonnet-5-5',out:10}, {id:'claude-opus-5-5',out:20},
    {id:'claude-opus-5',out:5,tentative:true},
  ]);
  function fixed(value,scale=SCALE){
    if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))return null;
    const m=String(value).match(/^\+?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);if(!m)return null;
    const digits=m[1]+(m[2]||''),shift=scale+Number(m[3]||0)-(m[2]||'').length;
    if(!Number.isSafeInteger(shift)||Math.abs(shift)>100)return null;
    if(shift>=0)return BigInt(digits)*10n**BigInt(shift);
    const d=10n**BigInt(-shift),n=BigInt(digits);return n%d===0n?n/d:null;
  }
  function gcd(a,b){while(b)[a,b]=[b,a%b];return a;}
  const normalize=id=>String(id||'').toLowerCase().split('@')[0].replace(/opus-5\.5/g,'opus-5-5').replace(/sonnet-5\.5/g,'sonnet-5-5');
  function messageMetadata(chat){
    if(!Array.isArray(chat?.messages))throw Error('会话接口缺少有序 messages 数组');
    return chat.messages.filter(m=>typeof m?.id==='string').map((m,order)=>{
      const parts=Array.isArray(m.parts)?m.parts:Array.isArray(m.content)?m.content:[];
      const text=m.role==='user'?(parts.filter(p=>p.type==='text').map(p=>p.text||'').join('')||
        (typeof m.content==='string'?m.content:typeof m.text==='string'?m.text:'')):'';
      const hasReasoning=m.role==='assistant'&&parts.some(p=>p.type==='reasoning'&&
        ((typeof p.text==='string'&&p.text.trim().length>0)||p.state==='streaming'));
      return {id:m.id,role:m.role,order,text,hasReasoning};
    });
  }
  function probeTurn(messages,sample,prompt){
    const boundary=sample.beforeLastMessageId?messages.findIndex(m=>m.id===sample.beforeLastMessageId):-1;
    const before=new Set(sample.beforeMessageIds||(boundary>=0?messages.slice(0,boundary+1).map(m=>m.id):[]));
    let matches=messages.filter(m=>m.role==='user'&&(sample.userId?m.id===sample.userId:m.text.trim()===prompt.trim()&&!before.has(m.id)));
    // 仅在发送前有消息边界、且 API 未返回用户正文时使用唯一新增用户消息。
    if(!matches.length&&!sample.userId&&(Array.isArray(sample.beforeMessageIds)||boundary>=0)){
      const added=messages.filter(m=>m.role==='user'&&!before.has(m.id));
      if(added.length===1&&!added[0].text)matches=added;
    }
    if(matches.length!==1)return {error:matches.length?'同一道探针出现多次，无法唯一关联':'未找到对应的探针消息',assistants:[]};
    const user=matches[0],start=messages.indexOf(user),next=messages.findIndex((m,i)=>i>start&&m.role==='user');
    const assistants=messages.slice(start+1,next<0?undefined:next).filter(m=>m.role==='assistant');
    return {userId:user.id,assistants,error:null};
  }
  function alignSamples(record,snapshot,probes){
    const rows=new Map((snapshot.rows||[]).map(r=>[r.id,r])),billed=new Set(snapshot.billedIds||rows.keys());
    let alignedProbes=0,waitingProbes=0,mappingErrors=0;const owned=new Set(),users=new Set();
    for(const sample of record.samples){
      const prompt=probes[sample.probeIndex]?.prompt;
      const turn=prompt?probeTurn(snapshot.messages||[],sample,prompt):{error:'探针编号无效',assistants:[]};
      delete sample.priceMappingError;sample.costIds=[];sample.assistantIds=[];
      if(turn.error||users.has(turn.userId)){
        sample.priceMappingError=turn.error||'多个探针关联到同一条消息';mappingErrors++;continue;
      }
      users.add(turn.userId);sample.userId=turn.userId;sample.assistantIds=turn.assistants.map(m=>m.id);
      sample.costIds=sample.assistantIds.filter(id=>rows.has(id));for(const id of sample.costIds)owned.add(id);
      if(!sample.assistantIds.length||sample.assistantIds.some(id=>!billed.has(id)))waitingProbes++;
      else alignedProbes++;
    }
    record.priceRows=[...owned].map(id=>rows.get(id)).sort((a,b)=>a.order-b.order);
    record.priceAlignment={alignedProbes,totalProbes:record.samples.length,waitingProbes,mappingErrors,
      billingError:snapshot.billingError||null,billingHttpStatus:snapshot.billingHttpStatus||null};
    return record.priceAlignment;
  }
  function orderedRows(cost,chat){
    if(!Array.isArray(chat?.messages))return {rows:[],unmapped:0,error:'会话接口缺少有序 messages 数组'};
    const index=new Map(chat.messages.filter(m=>typeof m?.id==='string').map((m,i)=>[m.id,{order:i,role:m.role}]));
    const rows=[],billedIds=[];let unmapped=0;
    for(const [id,m] of Object.entries(cost?.messages||{})){
      const pos=index.get(id);if(!pos){unmapped++;continue;}if(pos.role!=='assistant')continue;
      const a=m?.actual||m||{};
      if(a.outputTokensCostUsd!==null&&a.outputTokensCostUsd!==undefined&&Number.isFinite(Number(a.outputTokensCostUsd))&&Number(a.outputTokensCostUsd)>=0)billedIds.push(id);
      const r={id,...pos,source:a.source||m.source||null,pricingStrategy:m.pricingStrategy||a.pricingStrategy||null,isFallback:!!a.isFallback,isLongContext:!!a.isLongContext};
      for(const f of fields)r[f]=a[f]??null;
      if(Number.isFinite(Number(r.outputTokensCostUsd))&&Number(r.outputTokensCostUsd)>0)rows.push(r);
    }
    return {rows:rows.sort((a,b)=>a.order-b.order),messages:messageMetadata(chat),billedIds,unmapped,error:null};
  }
  function analyzePrice(rows,nearestId,catalog=prices){
    const expected=catalog.find(p=>normalize(p.id)===normalize(nearestId));
    const incoming=Array.isArray(rows)?rows:[];
    const precisionMissing=incoming.some(r=>Number(r.outputTokensCostUsd)>0&&fixed(r.outputTokensCostUsd)===null);
    const usable=incoming.filter(r=>fixed(r.outputTokensCostUsd)>0n);
    const perMessage=usable.map(r=>{
      const u=fixed(r.outputTokensCostUsd);
      const candidates=catalog.filter(p=>{const q=fixed(p.out,8);return q!==null&&q>0n&&u%q===0n;}).map(p=>p.id);
      return {id:r.id,order:r.order,outputTokensCostUsd:String(r.outputTokensCostUsd),candidates,source:r.source,pricingStrategy:r.pricingStrategy};
    });
    const provenance=new Set(usable.map(r=>`${r.source||'?'}|${r.pricingStrategy||'?'}`));
    const blocked=usable.some(r=>r.isFallback||r.isLongContext)||provenance.size>1;
    const values=usable.map(r=>fixed(r.outputTokensCostUsd));const g=values.length?values.reduce(gcd):null;
    const candidates=catalog.filter(p=>{const q=fixed(p.out,8);return g!==null&&q!==null&&q>0n&&g%q===0n;}).map(p=>p.id);
    const base={messages:usable.length,gcdUpper:g===null?null:Number(g)/Number(UNIT),candidates,perMessage,tableSource:'本地观测表（未独立验证，不完整）',possibleChange:false};
    if(precisionMissing)return {...base,gcdUpper:null,candidates:[],status:'insufficient',code:'precision',note:'金额精度无法用于精确比对'};
    if(blocked)return {...base,status:'insufficient',code:'billing_context',note:'计费来源或策略变化，或存在回退/长上下文；不合并比对',possibleChange:true};
    if(usable.length<2)return {...base,status:'insufficient',code:'too_few_costs',note:`已有 ${usable.length} 条可计算输出成本，至少需要两条进行比对`};
    if(!expected||expected.tentative)return {...base,status:'insufficient',code:'missing_reference',note:expected?.tentative?'该模型只有暂定参考价，尚未用于核验':'该模型尚未录入可用的本地参考价'};
    if(!usable.every(r=>r.source==='openrouter'&&r.pricingStrategy==='agent_p50'))return {...base,status:'insufficient',code:'billing_context',note:'账单计费来源/策略与参考表不同'};
    const divisor=fixed(expected.out,8),mismatch=values.some(u=>u%divisor!==0n);
    if(mismatch)return {...base,status:'conflict',note:`与本地表 $${expected.out}/百万输出 token 不相容；可能计费差异或阶段变化，需核验`,possibleChange:true};
    return {...base,status:'compatible',referencePrice:expected.out,note:`全部 ${usable.length} 条输出费用符合本地参考价 $${expected.out}/百万输出 token`};
  }
  function formatPrice(price){
    if(!price)return '费用核验：未读取';
    const labels={waiting_cost:'等待账单',mapping_failed:'消息关联失败',unavailable:'读取失败',missing_reference:'参考价未覆盖',billing_context:'计费口径不同',precision:'金额精度不足',too_few_costs:'费用条数不足',no_probes:'未选择探针'};
    const state=price.status==='compatible'?'费用相容':price.status==='conflict'?'费用不相容':labels[price.code]||'尚未完成';
    const count=Number.isInteger(price.totalProbes)?` · ${price.alignedProbes||0}/${price.totalProbes} 题费用完整`:'';
    return `费用核验：${state}${count}\n${price.note||''}`.trim();
  }
  function evidence(result,price){
    if(!result)return null;
    const enough=result.used_outputs===3&&result.status==='clear',conflict=price?.status==='conflict'||price?.possibleChange||result.probe_conflict;
    let reason;
    if(result.probe_conflict)reason='三题中的强候选互相矛盾；不能确定当前型号';
    else if(price?.status==='conflict')reason='探针费用与该候选的本地参考价不相容；需复查计费或模型阶段';
    else if(price?.possibleChange)reason='计费来源/策略不统一，或存在回退/长上下文；无法用统一价格核验';
    else if(result.used_outputs<3)reason=`有效探针 ${result.used_outputs}/3；请补完三题再判断`;
    else if(result.status==='close')reason='同类候选太接近，型号区分度不足；不是已确认型号';
    else if(result.status!=='clear')reason='整体匹配偏弱或家族区分不清；可能噪声或未覆盖模型，不能据此认定库外';
    else reason='三题指纹较清晰；仍是统计候选，非官方确认';
    if(price?.status==='compatible')reason+=`；费用相容${Number.isInteger(price.totalProbes)?`（${price.alignedProbes}/${price.totalProbes}题）`:''}`;
    else if(!conflict)reason+=`；${formatPrice(price).split('\n')[0]}`;
    return {status:enough&&!conflict?'supported':'pending',reason,price};
  }
  const label=e=>e?.status==='supported'?'较强候选':'待核验';
  const title=(name,e)=>`${e?.status==='supported'?'候选':'待核验'} · ${String(name||'未知').trim()}`.slice(0,100);
  const keepMatch=id=>/^(?:gpt-6(?:[.-]|$)|claude-opus-5[.-]5(?:[.-]|$)|claude-fable-5(?:[.-]|$))/.test(normalize(id));
  function timeline(rows){
    const sorted=[...(Array.isArray(rows)?rows:[])].sort((a,b)=>a.order-b.order),full=analyzePrice(sorted,null);
    const width=3,windows=[];
    for(let i=0;i+width<=sorted.length;i++){
      const group=sorted.slice(i,i+width),r=analyzePrice(group,null);
      windows.push({from:group[0].order,to:group.at(-1).order,gcdUpper:r.gcdUpper,candidates:r.candidates,precisionWarning:r.note.includes('精度')});
    }
    return {messages:full.messages,candidates:full.candidates,gcdUpper:full.gcdUpper,contextChanged:full.possibleChange,precisionWarning:full.note.includes('精度'),perMessage:full.perMessage.slice(-60),windows:windows.slice(-20),
      note:'gcd 仅是同价假设下的上界。窗口变化、命中或无命中均不能证明换模型或没换模型。'};
  }
  function formatTimeline(t){
    if(!t)return '';
    const windows=(t.windows||[]).slice(-4),valid=windows.filter(w=>!w.precisionWarning&&w.gcdUpper!==null);
    const values=new Set(valid.map(w=>w.gcdUpper));
    const observation=t.contextChanged?'不同口径的窗口不能直接比较。':valid.length<2?'尚无多个窗口可比较；不影响对本轮已关联费用进行价格核验。':values.size===1?'窗口上界稳定：未发现变化线索；不代表没换模型。':'窗口上界有变化：值得复查这些消息段；不代表一定换模型。';
    const lines=[`费用时间线 · ${t.messages} 条可计算回复`,
      `共同相容的本地参考：${(t.candidates||[]).map(id=>id+(prices.find(p=>p.id===id)?.tentative?'（暂定）':'')).join(' / ')||'暂无；参考表不完整'}`,
      `整段 gcd 上界：${t.gcdUpper??'未知'} 美元/百万输出 token（不是真实单价）`,
      observation,'本轮核验结论见上方；历史明细仅供复查。',
      '相容参考不是该条回复的身份；gcd 不能单独确定型号或证明换模型。',
      '消息 # 为会话中的位置（从 0 开始）；窗口包含连续 3 条有成本的助手回复。'];
    if(t.precisionWarning)lines.push('部分金额精度不足，未从取整值猜测单价。');
    for(const r of (t.perMessage||[]).slice(-16))lines.push(`消息 #${r.order}：输出费用 $${r.outputTokensCostUsd??'未知'} · ${r.source||'来源未知'}/${r.pricingStrategy||'策略未知'}`);
    for(const w of windows.slice(-4))lines.push(`窗口 #${w.from}–${w.to}：上界 ${w.precisionWarning?'精度不足':w.gcdUpper??'未知'} 美元/百万输出 token`);
    return lines.join('\n');
  }
  function costFlagValue(previous=''){
    let flags={};try{const value=JSON.parse(decodeURIComponent(previous));if(value&&typeof value==='object'&&!Array.isArray(value))flags=value;}catch{}
    // 只修改费用面板功能开关；不创建或修改认证凭据。
    flags['credit-system-m1']='cost-shown';return encodeURIComponent(JSON.stringify(flags));
  }
  globalThis.ArenaPriceRuntime=Object.freeze({fixed,gcd,prices,normalize,messageMetadata,probeTurn,alignSamples,orderedRows,analyzePrice,formatPrice,evidence,label,title,keepMatch,timeline,formatTimeline,costFlagValue});
})();
