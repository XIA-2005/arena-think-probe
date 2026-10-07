/* Arena 统一探测 · 基于 Perkica 旧版控制器/浮窗与自动抽卡流程。

   Standalone pipeline: 发送数字探针 → 捕获回复 → 本机指纹评分 → 面板显示候选，保留会话原名。
   保留：New Chat → 随机码暖场等回复 → 指纹探针 → 识别 → 保留/归档 → 下一轮；弱匹配追问和当前候选展示。
   合入：本轮消息 ID 取样、思维链停止后归档、22 模型库与可选费用核验。
   额度端点 /api/me/pulse 的语义来自 Arena Trace Inspector 2.3.2，详见 billing.js 顶部注释。 */
(() => {
  const {probes,probeAnswer,isTaskSuccessText,isContinueWorkText,planProbes}=globalThis.ArenaProbeRuntime;
  const records=new Map();
  const HOST_ID='arena-unified-model-probe';
  const PREFS_KEY='thinkprobe.v1.prefs';
  // Preserve the original probe's draw controls; the strict sampler and
  // reasoning/price checks are additional safeguards, not a replacement UI.
  const DEFAULTS=Object.freeze({rounds:5,mode:'quick',minPulse:0,keepOnly:false,manualKeepModels:[],thinkMode:'archive_skip',followUp:false,autoTaskFeedback:true});
  const KEEP_MODELS=Object.freeze(['GPT-5.4','GPT-5.5','GPT-5.6 Sol','GPT-5.6 Terra','GPT-5.6 Luna','GPT-6 Astra','GPT-6 Sol','GPT-6 Luna','Claude Haiku 4.5','Claude Sonnet 4.6','Claude Sonnet 5','Claude Sonnet 5.5','Claude Opus 4.6','Claude Opus 4.7','Claude Opus 4.8','Claude Opus 5','Claude Opus 5.5','Claude Fable 5.1','Kimi K2.6','Gemini 3.8 Flash','DeepSeek V4 Pro 0813','Qwen3.8 Max 0902']);
  const SVG_PROMPT='创建一个新 HTML，使用 SVG 绘制一个鹈鹕骑自行车的2D 动画。页面中只展示自动播放、循环播放的动画，不要解释、说明文字、按钮、菜单或任何交互功能，不需要任何测试。';
  const normalizeName=value=>String(value||'').trim().toLowerCase();
  const priceRuntime=globalThis.ArenaPriceRuntime;
  let priceNode,priceButton,timelineNode,costEnableButton;
  const MODE_LABEL=Object.freeze({quick:'快速 · 随机 1 题',precise:'精准 · 3 题全问'});
  const draw={running:false,cancelled:false,total:0,round:0,completed:0,failed:0,deleted:0,svgSent:0,phase:'idle',note:'',results:[],finishAfterRound:false,keepPolicy:null,thinkMode:null};
  let prefs={...DEFAULTS};
  let host=null,root=null,collapsed=false,panelControl=null,hudUserHidden=false;
  let runOneButton,runAllButton,stopButton,clearButton,progressNode,resultNode,resultModel,resultBadge,resultMetrics,resultBank,resultReason,compactText;
  let drawInput,drawMode,drawMinPulse,drawStartButton,drawStopButton,drawProgressNode,drawResultsNode,keepSyncNode,balanceNode,balanceNote,balanceButton,diagnoseButton,appendButton,drawKeepInput,drawKeepModelsNode,drawFollowUp,drawThinkMode;
  const keepModelCheckboxes=new Map();
  let skipGeneratingWait=false;
  let running=false,cancelled=false,sent=false,targetSession=null,phase='idle',progress='点击即发送真实探针，不再弹出确认';
  let pendingPrompt='';
  let balanceInfo=null,balanceError='',balanceLoading=false;

  const visible=element=>{
    if(!element?.isConnected||!element.getClientRects().length)return false;
    if(['dialog','alertdialog','menu'].includes(element.getAttribute('role'))&&element.getAttribute('data-state')==='closed')return false;
    if(typeof getComputedStyle==='function'){const style=getComputedStyle(element);if(style.display==='none'||style.visibility==='hidden')return false;}
    return true;
  };
  const session=()=>location.pathname.match(/^\/(?:agent|work)\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1]||null;
  const agentPage=()=>location.origin==='https://arena.ai'&&/^\/(?:agent|work)(?:\/|$)/.test(location.pathname);
  const agentPath=()=>location.pathname.replace(/\/$/,'');
  const isNewChatPath=path=>/^\/(?:agent|work)\/?$/.test(path);
  const editors=()=>[...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
  const editorText=element=>(element?.innerText??element?.textContent??'').trim();
  const combos=()=>[...document.querySelectorAll('button[role="combobox"],[role="combobox"]')].filter(visible);
  const modeReady=()=>combos().some(element=>/^(?:Agent|Work)(?:\s|$)/i.test(element.textContent.trim()));
  const generating=()=>[...document.querySelectorAll('button[aria-label]')].some(element=>visible(element)&&/stop|cancel/i.test(element.getAttribute('aria-label')||''))||[...document.querySelectorAll('[data-streaming="true"],[aria-busy="true"]')].some(visible);
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const fatal=message=>Object.assign(Error(message),{fatal:true});
  const pctText=value=>typeof value==='number'&&Number.isFinite(value)?(Math.round(value*10)/10)+'%':'—';
  const clock=iso=>{const date=iso?new Date(iso):null;return date&&Number.isFinite(date.getTime())?`${date.getMonth()+1}-${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`:'—';};

  /* ---------- 偏好设置：chrome.storage.local；不可用时退化为内存设置 ---------- */
  const clampInt=(value,min,max,fallback)=>{const number=Number(value);return Number.isInteger(number)&&number>=min&&number<=max?number:fallback;};
  function sanitizePrefs(value){
    // 兼容 2.0.x 的 probesPerChat：3 条 → 精准，其余 → 快速。
    const mode=value?.mode==='precise'||value?.probesPerChat===3?'precise':'quick';
    const manualKeepModels=Array.isArray(value?.manualKeepModels)?[...new Set(value.manualKeepModels.filter(x=>typeof x==='string'&&x.length<=160).slice(0,2000).map(x=>x.trim()).filter(Boolean))]:[];
    return {rounds:clampInt(value?.rounds,1,100,DEFAULTS.rounds),mode,minPulse:clampInt(value?.minPulse,0,100,DEFAULTS.minPulse),keepOnly:value?.keepOnly===true,manualKeepModels,thinkMode:['keep_skip','archive_skip','pause'].includes(value?.thinkMode)?value.thinkMode:DEFAULTS.thinkMode,followUp:value?.followUp===true,autoTaskFeedback:value?.autoTaskFeedback!==false};
  }
  const storageGet=key=>new Promise(resolve=>{try{chrome.storage.local.get(key,items=>resolve(items&&typeof items==='object'?items:{}));}catch{resolve({});}});
  const storageSet=value=>new Promise(resolve=>{try{chrome.storage.local.set(value,()=>resolve(true));}catch{resolve(false);}});
  async function loadPrefs(){
    const items=await storageGet(PREFS_KEY);
    // Independent extension: never import host instance settings or previous extension keys.
    prefs=sanitizePrefs(items[PREFS_KEY]);
  }
  async function savePrefs(patch){prefs=sanitizePrefs({...prefs,...patch});await storageSet({[PREFS_KEY]:prefs});paint();return prefs;}
  async function toggleKeepModel(name,checked){
    const target=normalizeName(name),selected=new Set(prefs.manualKeepModels.map(normalizeName));
    if(checked)selected.add(target);else selected.delete(target);
    const extras=prefs.manualKeepModels.filter(n=>!KEEP_MODELS.some(k=>normalizeName(k)===normalizeName(n)));
    await savePrefs({manualKeepModels:[...extras,...KEEP_MODELS.filter(k=>selected.has(normalizeName(k)))]});
  }
  /* 随机源：优先 crypto，保证「随机 1 题」不是可预测的伪随机。 */
  const cryptoRandom=()=>{const buffer=new Uint32Array(1);if(globalThis.crypto?.getRandomValues){crypto.getRandomValues(buffer);return buffer[0]/4294967296;}return Math.random();};
  const randomDigits=(maxLength=10)=>{const length=1+Math.floor(cryptoRandom()*Math.max(1,Math.floor(maxLength)));let text='';for(let i=0;i<length;i++)text+=String(Math.floor(cryptoRandom()*10));return text;};
  const usedProbeIndexes=record=>record.samples.map(sample=>sample.probeIndex).filter(index=>Number.isInteger(index));
  const planFor=(record,mode)=>planProbes(mode,usedProbeIndexes(record),cryptoRandom);

  function currentRecord(){const id=session();return id?records.get(id)||null:null;}
  function publicStatus(){
    const id=session(),record=id?records.get(id)||null:null;
    return {
      running:running||draw.running,
      phase:running?phase:(draw.running?draw.phase:(record?.phase||phase)),
      progress:running?progress:(draw.note||record?.progress||progress),
      sessionId:targetSession||id,
      samples:record?.samples.length||0,
      continueClicks:record?.continueClicks||0,
      result:record?.result||null,
      check:record?.lastCheck||null,
      price:record?.price||null,
      timeline:record?.timeline||null,
      provenance:record?.samples.map(({probeIndex,capturedAt,promptHash,sessionId,costIds})=>({probeIndex,capturedAt,promptHash,sessionId,costIds}))||[],
      draw:{running:draw.running,phase:draw.phase,note:draw.note,round:draw.round,total:draw.total,completed:draw.completed,failed:draw.failed,deleted:draw.deleted,svgSent:draw.svgSent,results:draw.results.slice(0,10)},
      prefs:{...prefs},
      balance:balanceInfo,balanceError,balanceLoading,
    };
  }
  function publish(nextPhase,text,record=null){phase=nextPhase;progress=text;if(record){record.phase=nextPhase;record.progress=text;}paint();}
  function publishDraw(nextPhase,text){draw.phase=nextPhase;draw.note=text;progress=text;paint();}
  function guard(expectedSession=null){
    if(cancelled)throw fatal('已停止；已经发送的消息不会撤回');
    if(!chrome.runtime?.id)throw fatal('扩展已重新加载或停用，请刷新 Arena 页面后再开始');
    if(!agentPage())throw fatal('已离开 Arena Agent 页面，探测停止');
    if(expectedSession&&session()!==expectedSession)throw fatal('已切换到其他聊天，探测停止');
  }
  function ensureReady(expectedSession=null){
    guard(expectedSession);
    if(generating())throw fatal('当前回复仍在生成，请等待结束后再探测');
    if(!modeReady())throw fatal('未确认 Agent Mode，请先切换到 Agent Mode');
    if(editors().some(element=>editorText(element)))throw fatal('输入框有未发送草稿；为避免覆盖，未发送探针');
  }
  function writeEditor(editor,text){
    editor.focus();const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
    if(editorText(editor)&&!document.execCommand('delete',false))throw Error('无法清空输入框；未发送');
    if(!document.execCommand('insertText',false,text))throw Error('无法写入探针；未发送');
  }
  async function waitFor(check,message,timeout=30000,expectedSession=null){
    const end=Date.now()+timeout;
    while(Date.now()<end){guard(expectedSession);const value=await check();if(value)return value;await sleep(250);}
    throw Error(message);
  }
  // Only in a user-started probe run: accept the one known Arena first-use
  // dialog, matching the host application's exact title and button.
  function knownTermsDialog(){
    const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible);
    // A footer link inside a survey wrapper is not a terms-of-use prompt.
    // Consent is only possible for the unique, exact dialog TITLE.
    const titles=d=>[...d.querySelectorAll('h1,h2,h3,[role="heading"],[data-slot="dialog-title"]')]
      .filter(visible).map(e=>String(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim()).filter(x=>x.length<160);
    const terms=dialogs.filter(d=>titles(d).includes('Terms of Use & Privacy Policy'));
    if(terms.length>1)throw fatal('出现多个网站服务条款弹窗，未自动同意');
    if(!terms.length){
      if(dialogs.some(d=>titles(d).some(t=>/terms of use|terms of service|服务条款|使用条款/i.test(t))))throw fatal('发现未识别的服务条款弹窗，请手动确认');
      return null;
    }
    const buttons=[...terms[0].querySelectorAll('button')].filter(b=>visible(b)&&!b.disabled&&b.getAttribute('aria-disabled')!=='true'&&String(b.textContent||'').trim()==='Agree');
    if(buttons.length!==1)throw fatal('网站服务条款的同意按钮不唯一，请手动确认');
    return {dialog:terms[0],button:buttons[0]};
  }
  async function acceptKnownTerms(expectedSession=null){
    const terms=knownTermsDialog();if(!terms)return false;
    guard(expectedSession);
    if(draw.running)publishDraw('terms','正在确认本账号首次使用条款（唯一的 Agree 按钮）…');
    else publish('terms','正在确认本账号首次使用条款（唯一的 Agree 按钮）…',currentRecord());
    terms.button.click();
    await waitFor(()=>![...document.querySelectorAll('[role="dialog"]')].filter(visible).some(d=>/Terms of Use & Privacy Policy/.test(d.innerText||'')),'网站服务条款未关闭；已停止发送，请手动核对',20000,expectedSession);
    return true;
  }
  function reasoningMarkers(){
    const scope=document.querySelector('[role="log"]')||document.querySelector('main');if(!scope)return [];
    return [...scope.querySelectorAll('[data-part-type="reasoning"],[data-type="reasoning"],[data-testid="reasoning"],[data-reasoning="true"],button,summary,[role="button"]')].filter(node=>visible(node)&&
      (node.matches('[data-part-type="reasoning"],[data-type="reasoning"],[data-testid="reasoning"],[data-reasoning="true"]')||/^(?:Thinking(?:\.{3}|…)?|Reasoning|Thought for \d+(?:\.\d+)?\s*(?:s|seconds)|思考中(?:\.{3}|…)?|思考|推理|已思考\s*\d+\s*秒)$/i.test(node.textContent.trim())));
  }
  function reasoningError(id,record,kind){
    record.reasoningDetected={sessionId:id,kind,detectedAt:new Date().toISOString()};
    return Object.assign(fatal('检测到本轮思维链；按设置处理当前会话'),{reasoning:true,sessionId:id});
  }
  async function checkReasoning(id,record,context){
    const markers=reasoningMarkers();
    if(markers.length>context.markers.size&&markers.some(node=>!context.markers.has(node)))throw reasoningError(id,record,'页面思考区块');
    if(Date.now()<(context.nextCheck||0))return;
    context.nextCheck=Date.now()+2000;
    let metadata;try{metadata=await chatSnapshot(id);}catch(error){context.snapshot=null;context.readError=error.message;return;}guard(id);
    context.snapshot=metadata;context.readError=null;
    const turn=priceRuntime.probeTurn(metadata.messages,context,context.prompt);
    if(turn.assistants.some(m=>m.hasReasoning))throw reasoningError(id,record,'接口推理段');
  }
  async function handleReasoning(error,record){
    const id=error.sessionId;
    const mode=draw.running?(draw.thinkMode||prefs.thinkMode):prefs.thinkMode;
    const action=mode==='pause'?'暂停并保留会话':mode==='keep_skip'?'停止生成、保留并跳过':'停止生成、归档并跳过';
    const notify=(phase,note)=>draw.running?publishDraw(phase,note):publish(phase,note,record);
    notify('thinking-handling',`检测到本轮思维链：${action}…`);
    record.reasoningDetected={...record.reasoningDetected,sessionId:id,mode,archived:false};
    let ok=false,archived=false,note='';
    try{
      guard(id);
      if(mode!=='pause'){
        if(generating()){
          const buttons=[...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled&&/^(?:Stop(?: generating| response| generation)?|停止生成|停止回复)$/i.test(button.getAttribute('aria-label')||''));
          if(buttons.length!==1)throw Error('当前生成停止按钮不明确；不会进入下一轮');
          buttons[0].click();
          await waitFor(()=>!generating(),'生成尚未停止；不会进入下一轮',10000,id);
        }
        guard(id);
        if(generating())throw Error('生成未确认停止；不会进入下一轮');
      }
      if(mode==='archive_skip'){
        const result=await globalThis.ArenaProbeRename.archive({sessionId:id,isCurrent:()=>!cancelled&&session()===id});
        if(result?.archived!==true)throw Error('归档结果未确认；不会进入下一轮');
        archived=true;record.reasoningDetected.archived=true;
        note='检测到本轮思维链：当前会话已确认归档；自动抽卡可继续下一轮';
        ok=true;
      }else if(mode==='keep_skip'){
        // A skipped conversation must be the original chat, not a newly opened one.
        guard(id);if(generating())throw Error('生成未停止；不会跳到下一轮');
        note='检测到本轮思维链：当前会话已保留，生成已停止；自动抽卡可继续下一轮';
        ok=true;
      }else note='检测到本轮思维链：已暂停抽卡，当前会话保持原状；请手动处理';
    }catch(e){record.reasoningDetected.error=e.message;note=`思维链处理未确认（${e.message}）；已停止抽卡，当前会话请手动核对`;}
    await saveSummary(id,record);
    notify(ok?'thinking-handled':'thinking-stopped',note);
    return {continueRound:ok,archived,note};
  }
  async function waitForReply(expected,expectedSession,record,round,context){
    const started=Date.now();let lastSignature='',changedAt=Date.now(),candidate=null,continued=false,continuedAt=0,promptSeenAt=0;
    while(Date.now()-started<600000){
      guard(expectedSession);const busy=generating();
      await acceptKnownTerms(expectedSession);
      await checkReasoning(expectedSession,record,context);
      const answer=probeAnswer(context.snapshot?.chat,context,expected);
      if(answer.status==='reasoning')throw reasoningError(expectedSession,record,'接口推理段');
      const next=answer.status==='ready'?answer.values:null,signature=next?.join(',')||answer.error||'';
      if(signature!==lastSignature){lastSignature=signature;changedAt=Date.now();candidate=next;}
      const ui=taskSuccessUi();
      if(!continued&&ui){continued=await clickContinueWork(expectedSession,record,round);continuedAt=Date.now();}
      if(!continued&&taskSuccessPromptVisible()&&!promptSeenAt)promptSeenAt=Date.now();
      const stable=Date.now()-changedAt;
      if(!busy&&answer.status==='invalid'&&stable>=2000&&!taskSuccessUi()&&!taskSuccessPromptVisible()){
        // 'invalid' means the assistant text was linked to THIS probe turn.
        // Unknown provenance or a still-streaming answer cannot be discarded.
        const error=Error(answer.error);
        error.code=answer.code==='out_of_range'?'out_of_range':'invalid_reply';
        error.sessionId=expectedSession;
        throw error;
      }
      if(continued&&!candidate&&Date.now()-continuedAt>=30000)throw Error(`采集失败：${context.readError||answer.error||'未定位到本轮正文'}；未计分，不读取整页兜底`);
      if(!continued&&promptSeenAt&&Date.now()-promptSeenAt>=6000)throw Error('已看到“任务成功”提示，但没有找到可点击的“继续工作”控件；已停止后续探针');
      if(candidate&&!busy){
        const nearComplete=candidate.length>=Math.ceil(expected*.9);
        if(continued&&((nearComplete&&stable>=500)||stable>=2000)){context.userId=answer.userId;context.assistantIds=answer.assistantIds;return candidate;}
        if(!continued&&stable>=12000){context.userId=answer.userId;context.assistantIds=answer.assistantIds;return candidate;}
      }
      await sleep(350);
    }
    throw Error('等待数字回复超时（10 分钟）；不会自动重发');
  }
  function controlLabels(element){return [element?.getAttribute?.('aria-label'),element?.getAttribute?.('title'),element?.value,element?.innerText,element?.textContent].map(value=>String(value||'').replace(/\s+/g,' ').trim()).filter(Boolean);}
  function taskSuccessPromptVisible(){return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="heading"],h1,h2,h3,h4,p')].some(element=>visible(element)&&isTaskSuccessText(`${element.getAttribute?.('aria-label')||''} ${element.textContent||''}`));}
  function taskSuccessUi(){
    const controls=[...document.querySelectorAll('button,[role="button"],[data-slot="button"],[tabindex]:not([tabindex="-1"]),input[type="button"],input[type="submit"]')].filter(element=>visible(element)&&!element.disabled&&element.getAttribute('aria-disabled')!=='true'&&controlLabels(element).some(isContinueWorkText));
    const unique=controls.filter((element,index)=>!controls.some((other,otherIndex)=>otherIndex!==index&&element.contains(other)));
    const contextual=unique.map(control=>{
      let container=control;
      for(let depth=0;container&&container!==document.body&&depth<14;depth++,container=container.parentElement){
        const label=`${container.getAttribute?.('aria-label')||''} ${container.textContent||''}`;
        if(isTaskSuccessText(label))return {control,container};
      }
      return null;
    }).filter(Boolean);
    // Never pair an unrelated Continue button with a page-wide prompt.
    const matches=contextual;
    if(matches.length>1)return {ambiguous:true,matches};
    return matches[0]||null;
  }
  async function clickContinueWork(expectedSession,record,round){
    const ui=taskSuccessUi();
    if(!ui)return false;
    if(typeof prefs!=='undefined'&&!prefs.autoTaskFeedback)throw fatal('自动过任务问题已关闭；请手动处理唯一的任务完成提示后继续');
    if(ui.ambiguous)throw fatal('页面上有多个“继续工作”控件，已停止自动操作');
    const yes=[...ui.container.querySelectorAll('button,[role="button"],[data-slot="button"],[tabindex]:not([tabindex="-1"]),input[type="button"],input[type="submit"]')]
      .filter(element=>visible(element)&&!element.disabled&&element.getAttribute('aria-disabled')!=='true'&&controlLabels(element).some(label=>/^(?:是|Yes)$/i.test(label)));
    if(yes.length>1)throw fatal('任务完成反馈的“是”按钮不唯一，已停止自动操作');
    const chooseYes=yes.length===1&&cryptoRandom()<0.8,chosen=chooseYes?yes[0]:ui.control;
    publish('continuing',`第 ${round} 条回复结束，正在点击任务反馈“${chooseYes?'是':'继续工作'}”…`,record);
    guard(expectedSession);chosen.click();
    await waitFor(()=>!taskSuccessUi(),'点击任务反馈后提示仍未关闭，已停止后续探针',10000,expectedSession);
    record.continueClicks=(record.continueClicks||0)+1;
    return true;
  }
  function newRecord(){return {samples:[],priceRows:[],price:null,result:null,checks:[],lastCheck:null,continueClicks:0,phase:'idle',progress:''};}
  async function score(record){
    // 快速模式可能只问了第 2/3 题：按题号长度升序（297→315→331）后交给后台，后台按该顺序校验。
    const outputs=[...record.samples].sort((left,right)=>probes[left.probeIndex].expected_count-probes[right.probeIndex].expected_count).map(sample=>({text:sample.text,expected_count:probes[sample.probeIndex].expected_count,challenge_id:probes[sample.probeIndex].id}));
    const response=await chrome.runtime.sendMessage({type:'AMP_SCORE',outputs,pageUrl:location.href});
    if(response?.error)throw Error(response.error);
    record.checks=response?.checks||[];record.lastCheck=record.checks.at(-1)||null;record.result=response?.result||null;
    if(record.result)record.result.evidence=priceRuntime.evidence(record.result,record.price);
    return record.result;
  }
  /* 发送一条探针、等待回复、评分。单条模式与自动抽卡共用这一条路径。 */
  async function captureProbe({record,probeIndex,expectedSession,label=''}){
    const probe=probes[probeIndex];await acceptKnownTerms(expectedSession);ensureReady(expectedSession);
    const editor=editors()[0];if(!editor)throw fatal('未找到 Agent 输入框；未发送探针');
    const baseline=expectedSession?await chatSnapshot(expectedSession):{messages:[]};
    guard(expectedSession);ensureReady(expectedSession);
    pendingPrompt=probe.prompt;writeEditor(editor,probe.prompt);
    const send=await waitFor(()=>sendButton(),'发送按钮不可用；未发送',30000,expectedSession);
    guard(expectedSession);if(editorText(editor)!==probe.prompt)throw fatal('输入内容已变化；未发送探针');
    const context={prompt:probe.prompt,markers:new Set(reasoningMarkers()),beforeMessageIds:baseline?.messages.map(m=>m.id),beforeLastMessageId:baseline?.messages.at(-1)?.id};
    sent=true;publish('sent',`${label}第 ${probeIndex+1} 题已发送，等待模型回复…`,record);send.click();
    let active=expectedSession;
    if(!active){
      try{active=await waitFor(async()=>{await acceptKnownTerms();return session();},'发送后未确认新会话；不会重发',30000,null);}
      catch(error){throw error?.fatal?error:fatal(error?.message||'发送后未确认新会话；不会重发');}
      targetSession=active;record=records.get(active)||record||newRecord();records.set(active,record);
    }
    guard(active);
    const values=await waitForReply(probe.expected_count,active,record,probeIndex+1,context);
    const hashBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(probe.prompt));
    const promptHash=[...new Uint8Array(hashBytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
    const sample={text:values.join(','),captured_count:values.length,probeIndex,capturedAt:new Date().toISOString(),promptHash,sessionId:active,costIds:[],beforeMessageIds:context.beforeMessageIds,beforeLastMessageId:context.beforeLastMessageId};
    sample.userId=context.userId;sample.assistantIds=context.assistantIds;sample.captureSource='api-text';
    record.samples.push(sample);
    try{
      for(let attempt=0;attempt<3;attempt++){
        const snapshot=await priceSnapshot(active);guard(active);record.timeline=priceRuntime.timeline(snapshot.rows);
        const turn=priceRuntime.probeTurn(snapshot.messages,sample,probe.prompt);
        if(turn.assistants.some(m=>m.hasReasoning))throw reasoningError(active,record,'接口推理段');
        const aligned=priceRuntime.alignSamples(record,snapshot,probes);
        if(!aligned.waitingProbes||aligned.billingError||aligned.mappingErrors||attempt===2)break;
        publish('billing',`等待探针账单：${aligned.alignedProbes}/${aligned.totalProbes}题费用完整…`,record);await sleep(750);
      }
    }catch(error){if(error.reasoning||error.fatal)throw error;record.priceAlignment={alignedProbes:0,totalProbes:record.samples.length,billingError:error.message};}
    guard(active);
    publish('scoring',`${label}第 ${probeIndex+1} 题捕获 ${values.length} 个数字，正在本机评分…`,record);
    const result=await score(record);
    record.price=probePrice(record);
    if(result)result.evidence=priceRuntime.evidence(result,record.price);
    await saveSummary(active,record);
    if(result){
      const verdict=priceRuntime.label(result.evidence);
      publish('scored',`${label}${verdict}：${result.nearest.display_name} · 已用 ${result.used_outputs}/${record.samples.length} 条有效回复`,record);
    }else publish('scored',`${label}${record.lastCheck?.message||'本条回复未通过计分门控'}`,record);
    pendingPrompt='';sent=false;return {record,sessionId:active};
  }
  async function run(mode='quick'){
    if(running||draw.running)return publicStatus();
    const precise=mode==='precise';
    draw.note='';cancelled=false;
    try{guard();}catch(error){publish('blocked',error?.message||'无法启动探测',currentRecord());return publicStatus();}
    let active=session(),record=active?records.get(active)||newRecord():newRecord();
    if(record.samples.some(s=>!s.text)){publish('blocked','历史结果可重新读取费用；原始数字未保存，请清除结果或新建聊天后重新识别',record);return publicStatus();}
    if(active&&!records.has(active))records.set(active,record);
    const first=planFor(record,precise?'precise':'quick');
    if(!first.length){publish('done','当前聊天三道题都已问过；清除结果或新建聊天后可重新探测',record);return publicStatus();}
    const goal=precise?3:record.samples.length+1;
    running=true;cancelled=false;sent=false;targetSession=active;
    publish('checking',precise?'精准模式：依次问完三道题（3 条回复）':`快速模式：随机发第 ${first[0]+1} 题（1 条回复）`,record);
    try{
      while(record.samples.length<goal){
        const plan=planFor(record,precise?'precise':'quick');
        if(!plan.length)break;
        const label=precise?`精准 ${record.samples.length+1}/3 · `:'快速 · ';
        const step=await captureProbe({record,probeIndex:plan[0],expectedSession:active,label});record=step.record;active=step.sessionId;targetSession=active;
        if(record.samples.length<goal){publish('waiting',`已捕获 ${record.samples.length} 条证据，准备下一题…`,record);await sleep(1200);}
      }
      const label=record.result?.nearest?.display_name||'暂无可靠候选';
      const verdict=record.result?priceRuntime.label(record.result.evidence):'未通过门控';
      publish('done',`${verdict}：${label} · 证据 ${record.samples.length}/3 条${record.samples.length<3?'（可点「再补 1 题」加强）':''} · 已处理任务反馈 ${record.continueClicks||0} 次 · 会话名称保持不变`,record);
    }catch(error){if(error.reasoning)await handleReasoning(error,record);else publish(cancelled?'stopped':'error',error?.message||'自动探测失败',record);}
    finally{running=false;sent=false;targetSession=null;paint();}
    return publicStatus();
  }
  function stop(){if(running){cancelled=true;publish('stopping','正在停止；不会再发送下一条');}return publicStatus();}
  function clearCurrent(){if(running||draw.running)return publicStatus();const id=session();if(id)records.set(id,newRecord());phase='idle';draw.note='';progress='当前聊天的内存结果已清除；可重新点「快速识别」或「三题核验」';paint();return publicStatus();}

  /* ---------- 自动抽卡：New Chat → 发探针 → 识别 → 保留/归档 → 下一轮 ---------- */
  function press(element){
    const base={bubbles:true,cancelable:true,composed:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true};
    element.dispatchEvent(new PointerEvent('pointerdown',{...base,buttons:1}));
    element.dispatchEvent(new PointerEvent('pointerup',{...base,buttons:0}));
    element.dispatchEvent(new MouseEvent('click',{...base,buttons:0}));
  }
  function sendButton(){
    const labelled=[...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled);
    const byLabel=labelled.find(button=>/^send\s*message$/i.test(String(button.getAttribute('aria-label')).trim()));
    if(byLabel)return byLabel;
    return labelled.find(button=>/^(send|发送)$/i.test(String(button.textContent||'').trim()))||null;
  }
  const NEW_CHAT_LABELS=['new chat','新建聊天','新对话','新的聊天','开始新对话'];
  function newChatLinks(){
    return [...document.querySelectorAll('a[href]')].filter(link=>{
      try{
        const url=new URL(link.href);
        if(url.origin!=='https://arena.ai'||url.pathname.replace(/\/$/,'')!==('/'+(agentPath().split('/')[1]||'agent')))return false;
        const text=String(link.textContent||'').trim().toLowerCase();
        const label=String(link.getAttribute('aria-label')||'').trim().toLowerCase();
        return NEW_CHAT_LABELS.includes(text)||NEW_CHAT_LABELS.some(value=>label.includes(value));
      }catch{return false;}
    });
  }
  function sidebarOpener(){
    const wanted=['Open sidebar','展开侧栏','打开侧边栏','展开侧边栏','Toggle Sidebar','Toggle sidebar','切换侧栏','展开导航'];
    return [...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled).find(button=>wanted.includes(button.getAttribute('aria-label')))||null;
  }
  function pickNewChatLink(links){return links.find(link=>link.getAttribute('data-sidebar')==='menu-button')||links[0]||null;}
  async function newChat(){
    guard();
    if(editors().some(element=>editorText(element)&&editorText(element)!==pendingPrompt))throw fatal('输入框有未发送草稿；为避免覆盖，未发送探针');
    let link=pickNewChatLink(newChatLinks());
    for(let attempt=0;!link&&attempt<2;attempt++){
      const opener=sidebarOpener();
      if(!opener)break;
      opener.click();
      try{await waitFor(()=>newChatLinks().length>0,'展开侧栏后仍未出现 New Chat 入口',4000,null);}catch{}
      link=pickNewChatLink(newChatLinks());
    }
    if(!link)throw Error('未找到 New Chat 入口，已停止本轮（可先点「自检」查看页面结构）');
    link.click();
    await waitFor(()=>isNewChatPath(agentPath()),'点击 New Chat 后页面没有回到 /work 或 /agent，已停止本轮',15000,null);
    await waitFor(()=>editors().length===1,'等待新聊天输入框超时',15000,null);
    const editor=editors()[0];
    // Arena 可能把刚提交的提示恢复成新聊天草稿；只清理我们自己的那一条。
    if(pendingPrompt&&editorText(editor)===pendingPrompt){
      editor.focus();const selection=window.getSelection(),range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('delete',false))throw Error('已进入新聊天，但残留提示未能清理；未再次发送');
      await waitFor(()=>!editorText(editors()[0]||editor),'新聊天草稿未能清空；未再次发送',8000,null);
    }
    if(editors().some(element=>editorText(element)))throw fatal('输入框有未发送草稿；为避免覆盖，未发送探针');
  }
  async function ensureMode(){
    if(modeReady())return;
    const combo=await waitFor(()=>combos()[0],'未找到模式选择器',10000,null);
    press(combo);
    const option=await waitFor(()=>[...document.querySelectorAll('[role="option"]')].find(element=>visible(element)&&/^(?:Agent|Work)(?:\s|$)/i.test(element.textContent.trim())&&element.getAttribute('aria-disabled')!=='true'&&!element.hasAttribute('data-disabled')),'未找到 Work / Agent Mode 选项',10000,null);
    press(option);
    await waitFor(modeReady,'未能确认 Agent Mode',10000,null);
  }
  async function refreshBalance(force=false){
    if(balanceLoading)return {balance:balanceInfo,error:balanceError};
    balanceLoading=true;paint();
    let error='';
    try{
      let response=null;
      try{response=await chrome.runtime.sendMessage({type:'AMP_BALANCE',force,pageUrl:location.href});}catch{}
      if(response?.balance)balanceInfo=response.balance;
      error=response?.error||'';
      if(!response?.balance||error){
        // 后台读取失败时用页面自身的同源请求兜底（页面就在 arena.ai 上）。
        try{
          const res=await fetch('/api/me/pulse',{method:'GET',credentials:'include',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
          if(!res.ok)throw Error(`HTTP ${res.status}`);
          const data=await res.json();
          const pulse=typeof data?.pulse==='number'&&Number.isFinite(data.pulse)&&data.pulse>=0?data.pulse:null;
          if(pulse===null)throw Error('响应缺少 pulse 字段');
          balanceInfo={pulse,refreshedAt:typeof data.refreshedAt==='string'?data.refreshedAt:null,receivedAt:new Date().toISOString()};
          error='';
        }catch(fallbackError){error=error||fallbackError?.message||'额度读取失败';}
      }
      balanceError=error;
      return {balance:balanceInfo,error:balanceError};
    }finally{balanceLoading=false;paint();}
  }

  async function enableCostPanel(){
    if(running||draw.running||!agentPage())return;
    const previous=document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('ph-toolbar-overrides='))?.slice('ph-toolbar-overrides='.length)||'';
    const value=priceRuntime.costFlagValue(previous);
    document.cookie=`ph-toolbar-overrides=${value}; path=/; max-age=86400; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`;
    publish('idle','已启用费用面板功能开关（1天）；若接口仍返回403，费用通道保持不可用');
    if(session())await refreshPrice();
  }
  async function getChatJson(id,suffix=''){
    if(!/^[a-zA-Z0-9-]{1,128}$/.test(id))throw Error('会话 ID 无效');
    let attempts=0;
    for(;;){
      const r=await fetch(`/api/chat/${id}${suffix}`,{method:'GET',credentials:'include',cache:'no-store',redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});
      if(r.status!==429){if(!r.ok)throw Object.assign(Error(`${suffix?'费用':'会话'}接口 HTTP ${r.status}`),{httpStatus:r.status});return r.json();}
      const retry=r.headers.get('Retry-After');const parsed=Number(retry);
      const server=retry&&Number.isFinite(parsed)&&parsed>=0?parsed:(retry&&Number.isFinite(Date.parse(retry))?(Date.parse(retry)-Date.now())/1000:0);
      const seconds=Math.max(5,Math.min(86400,Math.ceil(server||Math.min(1800,60*Math.pow(2,Math.min(attempts++,5))))));
      for(let left=seconds;left>0;left--){
        if(cancelled||draw.cancelled)throw fatal('已取消 HTTP 429 等待');
        if(draw.running&&(left===seconds||left%10===0||left<=5))publishDraw('cooldown',`HTTP 429：遵守网站限流等待，剩余 ${left} 秒；可以暂停`);
        await sleep(1000);
      }
    }
  }
  async function chatSnapshot(id){const chat=await getChatJson(id);return {messages:priceRuntime.messageMetadata(chat),chat};}
  async function priceSnapshot(id){
    const [chatResult,costResult]=await Promise.allSettled([getChatJson(id),getChatJson(id,'/cost?includeSession=true')]);
    if(chatResult.status==='rejected')throw chatResult.reason;
    const snapshot=priceRuntime.orderedRows(costResult.status==='fulfilled'?costResult.value:{},chatResult.value);
    if(snapshot.error)throw Error(snapshot.error);
    if(costResult.status==='rejected'){snapshot.billingError=costResult.reason.message;snapshot.billingHttpStatus=costResult.reason.httpStatus||null;}
    return snapshot;
  }
  function probePrice(record){
    const a=record.priceAlignment||{alignedProbes:0,totalProbes:record.samples.length,mappingErrors:record.samples.filter(s=>s.priceMappingError).length,waitingProbes:record.samples.filter(s=>!s.costIds?.length).length};
    const base={alignedProbes:a.alignedProbes,totalProbes:a.totalProbes,scope:'本轮探针消息',messages:record.priceRows.length};
    if(a.billingError)return {...base,status:'insufficient',code:'unavailable',note:a.billingError+(a.billingHttpStatus===403?'；可先启用费用面板开关，再读取费用':''),httpStatus:a.billingHttpStatus};
    if(a.mappingErrors)return {...base,status:'insufficient',code:'mapping_failed',note:`${a.mappingErrors}题未能唯一关联；${record.samples.find(s=>s.priceMappingError)?.priceMappingError||'请重试读取费用'}`};
    if(a.waitingProbes)return {...base,status:'insufficient',code:'waiting_cost',note:`${a.waitingProbes}题的回复成本尚未完整返回；点击“读取费用核验”可补齐，不会重发探针`};
    const unique=[...new Map(record.priceRows.map(r=>[r.id,r])).values()];
    return {...priceRuntime.analyzePrice(unique,record.result?.nearest.id),...base};
  }
  async function refreshPrice(){
    if(running||draw.running)return;const id=session();if(!id)return;
    const record=records.get(id)||await restorePriceRecord(id);if(session()!==id)return;records.set(id,record);
    try{
      const snapshot=await priceSnapshot(id);if(session()!==id)return;record.timeline=priceRuntime.timeline(snapshot.rows);
      if(record.samples.length){
        priceRuntime.alignSamples(record,snapshot,probes);record.price=probePrice(record);
      }else record.price={status:'insufficient',code:snapshot.billingError?'unavailable':'no_probes',note:snapshot.billingError||'本页没有已保存的探针记录；历史账单只显示明细，不核验当前模型',messages:0};
    }catch(e){record.price={status:'insufficient',code:'unavailable',note:e.message,messages:0};}
    if(record.result)record.result.evidence=priceRuntime.evidence(record.result,record.price);
    await saveSummary(id,record);paint();
  }
  async function restorePriceRecord(id){
    const data=await storageGet('arena.unified.history.v1'),saved=data['arena.unified.history.v1']?.[id],record=newRecord();
    if(saved?.sessionId===id&&Array.isArray(saved.provenance)){
      record.samples=saved.provenance.map(sample=>({...sample,costIds:sample.costIds||[]}));record.result=saved.result||null;
      record.timeline=saved.timeline||null;record.reasoningDetected=saved.reasoningDetected||null;
    }
    return record;
  }
  async function saveSummary(id,record){
    const key='arena.unified.history.v1',items=await storageGet(key),previous=items[key]||{};
    previous[id]={sessionId:id,updatedAt:new Date().toISOString(),result:record.result,price:record.price,timeline:record.timeline,reasoningDetected:record.reasoningDetected||null,provenance:record.samples.map(({probeIndex,capturedAt,promptHash,sessionId,costIds,userId,assistantIds,beforeLastMessageId})=>({probeIndex,capturedAt,promptHash,sessionId,costIds,userId,assistantIds,beforeLastMessageId}))};
    const history=Object.fromEntries(Object.entries(previous).sort((a,b)=>b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0,100));
    await storageSet({[key]:history});
  }

  /* 自检：只读取页面结构与额度，不发送任何消息、不消耗额度。 */
  async function diagnose(){
    const lines=[];
    const mark=(label,value)=>lines.push(`${value?'✅':'❌'} ${label}${typeof value==='string'?'：'+value:''}`);
    mark('Arena Agent 页面',agentPage());
    mark('Agent Mode 已选',modeReady());
    mark('输入框唯一可见',editors().length===1);
    mark('发送按钮可用',!!sendButton());
    mark('当前未在生成',!generating());
    const links=newChatLinks();
    mark('New Chat 入口',links.length?`找到 ${links.length} 个`:'未找到');
    mark('侧栏展开按钮',!!sidebarOpener());
    const id=session();
    mark('当前会话',id?id:'尚未创建（/agent 空白页）');
    if(id)mark('当前会话侧栏标签',[...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].some(link=>String(link.href).includes(id)));
    await refreshBalance(false);
    mark('额度 /api/me/pulse',typeof balanceInfo?.pulse==='number'?pctText(balanceInfo.pulse):(balanceError||'未读取'));
    const text=lines.join(' · ');
    publishDraw('diagnosed',text);
    return text;
  }
  const verdictOf=result=>result?priceRuntime.label(result.evidence):'未通过门控';
  // Each new chat receives a random 1–10 digit warm-up code before the
  // fingerprint. Ask for an explicit acknowledgement to avoid Arena's numeric
  // clarification card; the API boundary prevents warm-up replies being scored.
  function numericClarification(digits){
    const matches=[...document.querySelectorAll('button')].filter(button=>{
      if(button.textContent.trim()!=='Skip'||!button.getClientRects().length)return false;
      for(let card=button.parentElement,depth=0;card&&depth<8;card=card.parentElement,depth++){
        const text=card.textContent.replace(/[“”]/g,'"');
        if(text.length<1200&&text.includes(`What would you like me to do with "${digits}"?`)&&
          text.includes('Identify it')&&text.includes('Use it in a calculation')&&
          text.includes('Convert or format it'))return true;
      }
      return false;
    });
    return matches.length===1?matches[0]:null;
  }
  // Warm-up only: a fresh chat can render the unique code with surrounding
  // formatting. Keep fingerprint questions on the strict exact-prompt path.
  function warmupTurn(context){
    const messages=context.snapshot?.messages;if(!messages)return null;
    const exact=priceRuntime.probeTurn(messages,context,context.prompt);
    if(!exact?.error)return exact;
    const code=String(context.prompt||'').match(/warm-up code:\s*(\d{1,10})$/i)?.[1];
    if(!code)return exact;
    const users=messages.filter(m=>m.role==='user');
    const text=String(users[0]?.text||'').replace(/\*/g,'');
    const seen=text.match(/warm[-\s]?up\s+code\s*:\s*(\d{1,10})(?!\d)/i)?.[1];
    if(users.length!==1||seen!==code||!/reply\s+ok\b/i.test(text))return exact;
    return priceRuntime.probeTurn(messages,{...context,userId:users[0].id},context.prompt);
  }
  async function waitForDecoyReply(id,record,index,context){
    const started=Date.now();let continues=0,settleAt=0,skipAt=0,lastNotice=0;
    const digits=String(context.prompt).match(/(\d{1,10})$/)?.[1];
    while(Date.now()-started<240000){
      guard(id);
      await acceptKnownTerms(id);
      await checkReasoning(id,record,context);
      const card=digits?numericClarification(digits):null;
      if(card&&!context.skipClicked){
        if(card.disabled)throw fatal('暖场数字反问卡片不可跳过；已停止抽卡');
        guard(id);card.click();context.skipClicked=true;skipAt=Date.now();settleAt=0;
        publishDraw('decoy',`第 ${index} 轮：已跳过与随机码一致的数字反问，等待卡片关闭…`);
      }
      if(context.skipClicked&&card&&Date.now()-skipAt>15000)
        throw fatal('数字反问卡片跳过后仍未关闭；已停止抽卡，不创建新会话');
      const busy=generating(),ui=taskSuccessUi();
      if(ui&&continues<3){await clickContinueWork(id,record,index);continues++;settleAt=Date.now();}
      const turn=warmupTurn(context);
      if(turn?.assistants?.some(m=>m.hasReasoning))throw reasoningError(id,record,'随机码暖场回复的接口推理段');
      const replied=!turn?.error&&!!turn?.assistants?.some(m=>{
        const raw=context.snapshot.chat.messages.find(x=>x.id===m.id);
        const parts=Array.isArray(raw?.parts)?raw.parts:Array.isArray(raw?.content)?raw.content:[];
        return parts.some(p=>p.type==='text'&&typeof p.text==='string'&&p.text.trim()&&p.state!=='streaming')||
          (raw?.state!=='streaming'&&(typeof raw?.content==='string'&&!!raw.content.trim()||typeof raw?.text==='string'&&!!raw.text.trim()));
      });
      // Skip may dismiss the card without creating an assistant reply. Only
      // proceed after the card is gone, the same session is idle and stable.
      const dismissed=context.skipClicked&&!card;
      if(busy||ui||card||(!replied&&!dismissed))settleAt=0;
      else if(!settleAt)settleAt=Date.now();
      if((replied||dismissed)&&!busy&&!ui&&!card&&Date.now()-settleAt>=2500)return;
      if(Date.now()-lastNotice>=15000){
        lastNotice=Date.now();
        const reason=card?'数字反问卡片尚未关闭':ui?'等待“继续工作”提示关闭':busy?'网页仍显示生成中':
          replied?'已收到同轮暖场回复，等待稳定':dismissed?'反问卡片已跳过，等待页面稳定':
          context.readError?'同轮会话接口暂不可读：'+String(context.readError).slice(0,100):
          turn?.error?'同轮暖场消息尚未关联：'+turn.error:'等待同轮会话接口确认暖场 OK 回复';
        publishDraw('decoy-wait',`第 ${index} 轮：${reason}（${Math.floor((Date.now()-started)/1000)} 秒）；未发送指纹探针`);
      }
      await sleep(350);
    }
    throw fatal('等待暖场回复超时（4 分钟）；已停止抽卡，保留当前会话，未发送指纹探针');
  }
  async function sendDecoy({record,index}){
    const digits=randomDigits(10),prompt=`Please reply OK to this warm-up code: ${digits}`;
    await acceptKnownTerms();ensureReady();
    const editor=editors()[0];if(!editor)throw fatal('未找到 Agent 输入框；未发送暖场消息');
    pendingPrompt=prompt;writeEditor(editor,prompt);
    const send=await waitFor(()=>sendButton(),'发送按钮不可用；未发送随机码暖场',30000,null);
    guard();if(editorText(editor)!==prompt)throw fatal('输入内容已变化；未发送暖场消息');
    const context={prompt,markers:new Set(reasoningMarkers()),beforeMessageIds:[],beforeLastMessageId:null,skipClicked:false};
    sent=true;publishDraw('decoy',`第 ${index} 轮：已发送暖场随机码 ${digits}（${digits.length} 位），等待回复…`);send.click();
    let active;
    try{active=await waitFor(async()=>{await acceptKnownTerms();return session();},'发送随机码暖场后未确认新会话；不会重发',30000,null);}
    catch(error){throw error?.fatal?error:fatal(error?.message||'发送暖场消息后未确认新会话；已停止抽卡，不会重发');}
    targetSession=active;record=records.get(active)||record||newRecord();records.set(active,record);
    try{await waitForDecoyReply(active,record,index,context);}
    catch(error){
      if(error?.reasoning||error?.fatal)throw error;
      throw fatal(`暖场消息未完成，已停止抽卡；保留当前会话供核对：${error?.message||'未知原因'}`);
    }
    pendingPrompt='';sent=false;
    return {record,sessionId:active};
  }
  const keepMatch=(result,list)=>{
    const normalized=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ' ).trim();
    const name=normalized(result.nearest.display_name),id=normalized(result.nearest.id.split('@')[0]);
    return list.some(value=>{const key=normalized(value);return key.length>=3&&(name===key||id===key||
      // A family-only group can match its variants; a specific "Opus 5"
      // selection must not accidentally include "Opus 5.5".
      (/^gpt [0-9]+$/.test(key)&&(name.startsWith(key+' ')||id.startsWith(key+' '))));});
  };
  function retentionFor(){
    // Freeze one round's selection: changes in the popup never alter an in-flight archive decision.
    return draw.running&&draw.keepPolicy?draw.keepPolicy:{enabled:prefs.keepOnly,models:prefs.manualKeepModels};
  }
  function excludesSelected(result){
    const selected=retentionFor();
    return !!result&&selected.enabled&&selected.models.length>0&&!keepMatch(result,selected.models);
  }
  function shouldArchiveUnselected(result,record){
    // A non-selected candidate is archived only after three valid, non-conflicting answers.
    return excludesSelected(result)&&record?.samples.length===3&&result.used_outputs===3&&
      !result.probe_conflict&&(result.status==='clear'||result.status==='close')&&
      result.evidence?.price?.status!=='conflict'&&!result.evidence?.price?.possibleChange;
  }
  async function sendSvgNoWait(expectedSession){
    guard(expectedSession);
    const editor=editors()[0];if(!editor)return '未找到输入框，未发送SVG';
    if(editorText(editor))return '输入框有内容，未发送SVG';
    pendingPrompt=SVG_PROMPT;
    try{writeEditor(editor,SVG_PROMPT);}catch(error){pendingPrompt='';return '写入SVG失败：'+(error?.message||'');}
    const send=await waitFor(()=>sendButton(),'发送按钮不可用，未发送SVG',10000,expectedSession);
    guard(expectedSession);
    if(editorText(editor)!==SVG_PROMPT){pendingPrompt='';return '输入内容变化，未发送SVG';}
    sent=true;send.click();skipGeneratingWait=true;
    return '已发送SVG（未等待回复）';
  }
  async function drawRound(index){
    if(!skipGeneratingWait&&generating()){publishDraw('waiting',`第 ${index} 轮：上一条回复仍在生成，等待结束后再新建聊天…`);await waitFor(()=>!generating(),'上一条回复超过 240 秒仍在生成，本轮跳过',240000,null);}
    skipGeneratingWait=false;
    publishDraw('new-chat',`第 ${index} 轮：正在点击 New Chat…`);
    await newChat();
    publishDraw('mode',`第 ${index} 轮：正在确认 Agent Mode…`);
    await ensureMode();
    guard();
    if(!isNewChatPath(agentPath())||session())throw Error('新聊天状态已变化；未发送');
    if(!modeReady())throw Error('模式已变化；未发送');
    if(editors().some(element=>editorText(element)))throw fatal('输入框有未发送草稿；为避免覆盖，未发送探针');
    const mode=prefs.mode==='precise'?'precise':'quick';
    const plan=planProbes(mode,[],cryptoRandom);
    let active=null,record=newRecord(),lastResult=null;
    const decoy=await sendDecoy({record,index});
    record=decoy.record;active=decoy.sessionId;targetSession=active;
    for(const [order,probeIndex] of plan.entries()){
      const label=`第 ${index} 轮 · ${mode==='precise'?`精准 ${order+1}/${plan.length} · `:'快速 · '}`;
      const step=await captureProbe({record,probeIndex,expectedSession:active,label});
      record=step.record;active=step.sessionId;targetSession=active;lastResult=record.result;
      if(order+1<plan.length)await sleep(1200);
    }
    // Verify any non-selected candidate with every question before an archive decision.
    if(excludesSelected(lastResult)&&record.samples.length<3){
      const remaining=planProbes('precise',usedProbeIndexes(record),cryptoRandom);
      publishDraw('retention-check',`第 ${index} 轮：候选不在面板保留组，补齐剩余 ${remaining.length} 题再决定是否归档…`);
      for(const [order,probeIndex] of remaining.entries()){
        const step=await captureProbe({record,probeIndex,expectedSession:active,label:`第 ${index} 轮 · 保留组核验 ${order+1}/${remaining.length} · `});
        record=step.record;active=step.sessionId;targetSession=active;lastResult=record.result;
        if(order+1<remaining.length)await sleep(1200);
      }
    }
    if(prefs.followUp&&lastResult&&lastResult.status==='weak'&&!shouldArchiveUnselected(lastResult,record)){
      const remaining=planProbes('precise',usedProbeIndexes(record),cryptoRandom);
      if(remaining.length){
        publishDraw('followup',`第 ${index} 轮：弱匹配，追问剩余 ${remaining.length} 题…`);
        for(const [order,probeIndex] of remaining.entries()){
          const step=await captureProbe({record,probeIndex,expectedSession:active,label:`第 ${index} 轮 · 追问 ${order+1}/${remaining.length} · `});
          record=step.record;active=step.sessionId;targetSession=active;lastResult=record.result;
          if(order+1<remaining.length)await sleep(1200);
        }
      }
    }
    if(!lastResult)throw fatal(`第 ${index} 轮指纹未通过取样门控：${record.lastCheck?.message||'无有效模型候选'}；已停止抽卡，保留当前会话供核对`);
    const label=lastResult.nearest.display_name,verdict=verdictOf(lastResult);
    if(prefs.followUp&&lastResult.status==='weak'&&!shouldArchiveUnselected(lastResult,record)){
      publishDraw('svg',`第 ${index} 轮：${label} 仍为弱匹配，发送鹈鹕 SVG 后继续…`);
      const note=await sendSvgNoWait(active);
      return {sessionId:active,label,verdict,status:lastResult.status,deleted:false,svgSent:note.startsWith('已发送SVG'),note,retention:'待核验'};
    }
    if(shouldArchiveUnselected(lastResult,record)){
      publishDraw('archive',`第 ${index} 轮：${label} 非保留模型，正在归档…`);
      try{
        const archived=await globalThis.ArenaProbeRename.archive({sessionId:active,isCurrent:()=>!cancelled&&session()===active});
        if(!archived?.archived)throw Error('归档操作未确认成功');
        return {sessionId:active,label,verdict,status:lastResult.status,deleted:true,svgSent:false,note:'已归档',retention:'已归档'};
      }catch(error){throw fatal(`非保留模型归档失败：${error?.message||'未知原因'}；已停止抽卡，请手动核对`);}
    }
    const fit=Number(lastResult.signals?.fit),separation=Number(lastResult.signals?.separation);
    const keep=retentionFor();
    const selected=keepMatch(lastResult,keep.models);
    const retention=excludesSelected(lastResult)?'三题证据不足或冲突 · 未归档':lastResult.evidence?.status!=='supported'?'待核验':selected?'保留候选':'其他候选';
    return {sessionId:active,label,verdict:retention,status:lastResult.status,note:'会话名称保持不变',fit,separation,retention};
  }
  async function runDraw(rounds,patch={}){
    if(draw.running||running)return publicStatus();
    const count=Number(rounds);
    if(!Number.isInteger(count)||count<1||count>100){publishDraw('blocked','轮数必须是 1–100 的整数');return publicStatus();}
    cancelled=false;sent=false;targetSession=null;
    prefs=sanitizePrefs({...prefs,...patch,rounds:count});
    draw.running=true;draw.cancelled=false;draw.finishAfterRound=false;draw.total=count;
    draw.keepPolicy={enabled:prefs.keepOnly,models:[...prefs.manualKeepModels]};draw.thinkMode=prefs.thinkMode;
    draw.round=0;draw.completed=0;draw.failed=0;draw.deleted=0;draw.svgSent=0;draw.results=[];
    let consecutive=0,halted=false;
    const roundTotal=count;
    publishDraw('checking',`准备连续抽卡：共 ${roundTotal} 轮 · ${MODE_LABEL[prefs.mode]||MODE_LABEL.quick}${prefs.minPulse>0?` · 额度低于 ${prefs.minPulse}% 自动停止`:''}`);
    try{
      guard();
      void storageSet({[PREFS_KEY]:prefs});
      if(prefs.minPulse>0)await refreshBalance(true);
      for(draw.round=1;draw.round<=count;draw.round++){
        if(draw.finishAfterRound)break;
        if(prefs.minPulse>0){
          const pulse=typeof balanceInfo?.pulse==='number'?balanceInfo.pulse:null;
          if(pulse!==null&&pulse<prefs.minPulse){halted=true;publishDraw('stopped',`额度剩余 ${pctText(pulse)} 低于阈值 ${prefs.minPulse}%，已停止抽卡（第 ${draw.round} 轮未发送）`);break;}
        }
        publishDraw('round',`第 ${draw.round}/${roundTotal} 轮：新建聊天 → 发随机码暖场等回复 → 发送探针（${MODE_LABEL[prefs.mode]||MODE_LABEL.quick}）→ 识别 → 保留原名或归档`);
        try{
          // A partially populated session must never be silently skipped.
          targetSession=null;
          const result=await drawRound(draw.round);
          draw.results.unshift({round:draw.round,at:Date.now(),label:result.label,verdict:result.verdict,retention:result.retention||'待核验',deleted:!!result.deleted,svgSent:!!result.svgSent,sessionId:result.sessionId});
          if(draw.results.length>25)draw.results.length=25;
          if(result.status==='none')draw.failed++;else{draw.completed++;if(result.deleted)draw.deleted++;if(result.svgSent)draw.svgSent++;}
          consecutive=0;
          publishDraw(result.deleted?'archived':result.svgSent?'svg':'scored',`第 ${draw.round}/${roundTotal} 轮：${result.verdict} ${result.label}${result.note?' · '+result.note:''}`);
          if(prefs.minPulse>0)void refreshBalance(false);
        }catch(error){
          if(draw.cancelled)throw error;
          if(error.reasoning){
            const record=records.get(error.sessionId)||newRecord();
            const outcome=await handleReasoning(error,record);
            draw.results.unshift({round:draw.round,sessionId:error.sessionId,label:'检测到本轮思维链',deleted:outcome.archived,retention:outcome.note});
            if(draw.results.length>25)draw.results.length=25;
            if(outcome.archived)draw.deleted++;
            if(!outcome.continueRound||draw.cancelled){halted=true;break;}
            draw.failed++;consecutive=0;sent=false;targetSession=null;
            await sleep(600);
            continue;
          }
          // Broken chat: one safe Try again, then classify only from scored evidence
          // belonging to this exact session. Never touch Reset session/sign-out.
          const broken=()=>/Something went wrong/i.test(document.body?.innerText||'')&&/couldn['’]?t load this chat/i.test(document.body?.innerText||'');
          if(targetSession&&session()===targetSession&&broken()){
            const retry=[...document.querySelectorAll('button')].filter(b=>visible(b)&&!b.disabled&&/^Try again$/i.test(b.innerText.trim()));
            if(retry.length===1){publishDraw('recovering',`第 ${draw.round} 轮加载出错：点击 Try again，等待网页恢复…`);retry[0].click();await sleep(8000);}
            if(broken()&&session()===targetSession&&!generating()){
              const prior=records.get(targetSession),result=prior?.result;
              if(result&&shouldArchiveUnselected(result,prior)){
                try{
                  const archived=await globalThis.ArenaProbeRename.archive({sessionId:targetSession,isCurrent:()=>!cancelled&&session()===targetSession});
                  if(!archived?.archived)throw Error('归档结果未确认');
                  draw.results.unshift({round:draw.round,at:Date.now(),sessionId:targetSession,label:result.nearest.display_name,retention:'出错页 · 非目标已归档',deleted:true});
                  draw.deleted++;draw.failed++;sent=false;targetSession=null;consecutive=0;
                  publishDraw('archived',`第 ${draw.round} 轮：已有核验的非目标会话已归档，继续新会话`);
                  continue;
                }catch(archiveError){halted=true;publishDraw('stopped',`出错页非目标归档未确认：${archiveError.message}；保留原会话并停止`);break;}
              }
              const selected=retentionFor();
              if(result&&!result.probe_conflict&&result.used_outputs>=1&&['clear','close'].includes(result.status)&&
                selected.synced&&(selected.all||keepMatch(result,selected.models))){
                draw.results.unshift({round:draw.round,at:Date.now(),sessionId:targetSession,label:result.nearest.display_name,retention:'出错页 · 目标保留'});
                draw.completed++;sent=false;targetSession=null;consecutive=0;
                publishDraw('preserved',`第 ${draw.round} 轮：已有核验的目标会话保留，继续新会话`);
                continue;
              }
              halted=true;publishDraw('stopped','Try again 后聊天仍无法加载；没有可核验的目标/非目标证据，保留当前会话并停止，不点击 Reset session');break;
            }
          }
          // Only a settled, linked invalid reply in THIS chat is recoverable.
          // Unknown provenance, live generation, login/challenge or changed chat stop.
          if(!error?.fatal&&['out_of_range','invalid_reply'].includes(error?.code)&&error.sessionId&&
             error.sessionId===targetSession&&
             session()===error.sessionId&&!generating()){
            publishDraw('archive',`第 ${draw.round}/${roundTotal} 轮：本轮回复无效（${error.message}），未计分；归档当前会话后继续…`);
            try{
              const archived=await globalThis.ArenaProbeRename.archive({sessionId:error.sessionId,isCurrent:()=>!cancelled&&session()===error.sessionId});
              if(!archived?.archived)throw Error('归档未确认成功');
              if(session()!==error.sessionId||generating())throw Error('归档确认后会话已变化或仍在生成');
              draw.results.unshift({round:draw.round,at:Date.now(),sessionId:error.sessionId,label:String(error.message||'本轮回复无效').slice(0,100),retention:'已归档 · 未计分',deleted:true});
              if(draw.results.length>25)draw.results.length=25;
              draw.failed++;draw.deleted++;consecutive=0;sent=false;targetSession=null;
              if(draw.cancelled){halted=true;publishDraw('stopped','无效回复已归档，但已手动暂停；不会开始新对话');break;}
              if(draw.finishAfterRound){publishDraw('done','无效回复已归档；批次已达目标，不开始下一轮');break;}
              publishDraw('archived',`第 ${draw.round}/${roundTotal} 轮：无效回复已确认归档，继续新会话`);
              await sleep(600);continue;
            }catch(archiveError){halted=true;publishDraw('stopped',`无效回复归档未确认：${archiveError?.message||'未知原因'}；已停止，不自动打开下一会话`);break;}
          }
          if(error?.fatal||sent||targetSession){halted=true;publishDraw('stopped',error?.message||'本轮已发送消息但未完成识别；已停止抽卡，请核对当前会话');break;}
          draw.failed++;consecutive++;
          publishDraw('skipped',`第 ${draw.round}/${roundTotal} 轮失败：${error?.message||'未知原因'}${consecutive>=3?'；连续失败 3 次，已停止抽卡':'；跳过本轮'}`);
          if(consecutive>=3){halted=true;break;}
        }
        if(draw.finishAfterRound){publishDraw('done','指定抽卡数量已够：本轮结束，不再发送下一题');break;}
        guard();
        await sleep(600);
      }
      if(!halted)publishDraw('done',`抽卡结束：成功识别 ${draw.completed} 轮（归档 ${draw.deleted} 个 · 发SVG ${draw.svgSent} 个），跳过 ${draw.failed} 轮；会话名称保持不变，不再自动发送`);
    }catch(error){publishDraw('stopped',`抽卡停止：${error?.message||'未知原因'}`);}
    finally{draw.running=false;draw.cancelled=false;draw.keepPolicy=null;draw.thinkMode=null;sent=false;targetSession=null;paint();}
    return publicStatus();
  }
  function stopDraw(){if(draw.running){draw.cancelled=true;cancelled=true;publishDraw('stopping','正在停止抽卡；不会再发送新消息');}else stop();}

  function el(tag,className,text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;}
  function createHud(){
    panelControl?.destroy();panelControl=null;document.getElementById(HOST_ID)?.remove();host=el('div');host.id=HOST_ID;host.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647';host.hidden=hudUserHidden;host.style.display=hudUserHidden?'none':'';root=host.attachShadow({mode:'closed'});
    const style=el('style');style.textContent=`:host{all:initial}.box{display:flex;flex-direction:column;max-height:min(520px,calc(100dvh - 24px));box-sizing:border-box;width:340px;max-width:calc(100vw - 24px);border:1px solid #3d5e51;border-radius:14px;background:#101a20;color:#e7f1ed;box-shadow:0 16px 50px #0008;font:12px/1.5 system-ui,sans-serif;overflow:hidden}.box *{box-sizing:border-box}[hidden]{display:none!important}.head{flex-shrink:0;cursor:grab;touch-action:none;user-select:none;display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid #2a3d40;background:#142329}.mark{display:grid;place-items:center;width:23px;height:23px;border:1px solid #56816d;border-radius:7px;background:#224639;color:#bdf0d4;font:700 12px ui-monospace,monospace}.title{flex:1}.title b,.title small{display:block}.title b{font-size:11px}.title small{font-size:8px;color:#84a39c;letter-spacing:.8px}.collapse{width:25px;height:25px;padding:0}.body{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:11px}.head:focus-visible,.compact:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid #98e3bd;outline-offset:-3px}:host([data-dragging]) .head,:host([data-dragging]) .compact{cursor:grabbing}.reason{margin:7px 0 0;color:#d5e9df;font-size:10px;overflow-wrap:anywhere}.help{margin:8px 0;font-size:10px;color:#c7d9d2}.help summary,.timeline-details summary{cursor:pointer;padding:5px 0}.help p{margin:5px 0}.timeline{font:10px/1.65 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;overscroll-behavior:contain}.warning{margin:0 0 9px;padding:7px 8px;border-left:2px solid #b48645;background:#251f15;color:#d9c18e;font-size:9px}.controls{display:grid;grid-template-columns:1fr 1fr;gap:6px}.minor{display:flex;gap:6px;margin-top:6px}.minor button{flex:1}button{border:1px solid #466257;border-radius:7px;padding:7px 8px;background:#172823;color:#cfe9dc;font:10px system-ui,sans-serif;cursor:pointer}button:hover:not(:disabled){filter:brightness(1.15)}button:disabled{opacity:.4;cursor:default}.primary{background:#286149;border-color:#559174;color:#f0fff7;font-weight:650}.all{background:#23453a}.stop{color:#efb1ab;border-color:#744b49}.progress{min-height:31px;margin:8px 1px 0;color:#9eb7b0;font-size:9px;line-height:1.55;overflow-wrap:anywhere}.result{margin-top:8px;padding:9px;border:1px solid #416a56;border-radius:9px;background:#173127}.result-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.model{font:650 14px/1.3 ui-monospace,Consolas,monospace;color:#b8efd2;overflow-wrap:anywhere}.badge{white-space:nowrap;border:1px solid #55816b;border-radius:999px;padding:2px 6px;color:#bfead5;font-size:8px}.result[data-level=close]{border-color:#735f39;background:#2a2418}.result[data-level=close] .model{color:#ecd49a}.result[data-level=weak]{border-color:#704946;background:#2d2021}.result[data-level=weak] .model{color:#e9b0aa}.metrics{margin-top:6px;color:#9fb8b1;font:9px/1.55 ui-monospace,Consolas,monospace}.bank{margin-top:4px;color:#748f89;font-size:8px}.draw{margin-top:9px;padding:9px;border:1px solid #35544a;border-radius:9px;background:#12211c}.draw-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:10px;color:#d6ece2;font-weight:650}.draw-grid{display:grid;grid-template-columns:auto 1fr;gap:5px 7px;align-items:center;font-size:9px;color:#9eb7b0}.draw-grid input,.draw-grid select{width:100%;border:1px solid #466257;border-radius:6px;background:#0d1714;color:#dff3e9;padding:4px 6px;font:10px system-ui,sans-serif}.draw-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}.draw-minor{margin-top:6px}.draw-minor button{width:100%}.draw-note{margin:7px 0 0;color:#9eb7b0;font-size:9px;line-height:1.5;overflow-wrap:anywhere}.results{margin-top:6px;display:grid;gap:3px;max-height:108px;overflow:auto}.results div{display:flex;justify-content:space-between;gap:6px;font:9px ui-monospace,Consolas,monospace;color:#a8c3bb}.results b{color:#c8efd9;font-weight:600}.balance{margin-top:8px;padding:7px 8px;border:1px solid #35544a;border-radius:9px;background:#12211c}.balance-row{display:flex;align-items:center;justify-content:space-between;gap:7px;font-size:9px;color:#9eb7b0}.balance-row b{color:#c8efd9;font:600 12px ui-monospace,Consolas,monospace}.balance-note{margin:4px 0 0;color:#7d968f;font-size:8px;line-height:1.5;overflow-wrap:anywhere}.compact{flex-shrink:0;cursor:grab;touch-action:none;user-select:none;display:flex;align-items:center;gap:7px;padding:8px 10px}.compact-text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#b8e9d1;font:600 11px system-ui}.expand{width:24px;height:24px;padding:0}.byline{margin:8px 1px 0;color:#6d8a83;font-size:8px;text-align:center}`;
    const box=el('section','box'),head=el('header','head'),mark=el('span','mark','M'),title=el('div','title');title.append(el('b','','防think指纹探针'),el('small','','v1.0，by hhhhhhhh'));title.title='拖动标题移动面板';const collapse=el('button','collapse','—');collapse.title='收起';collapse.setAttribute('aria-label','收起浮窗');collapse.addEventListener('click',()=>{collapsed=true;paint();panelControl?.persist();});const reset=el('button','collapse','↺');reset.title='复位到右下角';reset.setAttribute('aria-label','复位浮窗到右下角');reset.addEventListener('click',()=>panelControl?.reset());head.append(mark,title,reset,collapse);
    const body=el('div','body'),warning=el('p','warning','严格关联本轮消息 ID，只读助手 text。思维链按下方模式处理；归档未确认、停止生成失败均停机。'),controls=el('div','controls');runOneButton=el('button','primary','快速识别 · 随机1题');runAllButton=el('button','all','三题核验 · 3题全问');controls.append(runOneButton,runAllButton);const minor=el('div','minor');appendButton=el('button','','再补 1 题');stopButton=el('button','stop','停止');clearButton=el('button','','清除结果');minor.append(appendButton,stopButton,clearButton);progressNode=el('p','progress');progressNode.setAttribute('role','status');
    resultNode=el('section','result');const resultTop=el('div','result-top');resultModel=el('div','model');resultBadge=el('span','badge');resultTop.append(resultModel,resultBadge);resultMetrics=el('div','metrics');resultBank=el('div','bank');resultReason=el('p','reason');resultNode.append(resultTop,resultReason,resultMetrics,resultBank);
    const levelHelp=el('details','help');levelHelp.append(el('summary',null,'判定级别怎么读？'),el('p',null,'较强候选：三题指纹较清晰，没有单题或费用矛盾；仍非官方确认。'),el('p',null,'待核验：题数不足、匹配弱、型号太接近、单题矛盾或费用矛盾。具体原因显示在候选下面。'),el('p',null,'费用不足不会单独降级；指纹子状态：清晰 / 接近 / 弱匹配。'));const timelineDetails=el('details','timeline-details');timelineDetails.append(el('summary',null,'查看费用时间线（价格相容与变化线索）'));timelineNode=el('pre','timeline');timelineDetails.append(el('p','draw-note','相容表示费用没有排除候选；矛盾表示与本地参考表不符。窗口稳定或变化都不能单独证明模型身份或切换。'),timelineNode);
    priceNode=el('p','draw-note');priceButton=el('button',null,'读取费用核验（不发送）');priceButton.addEventListener('click',()=>void refreshPrice());
    costEnableButton=el('button',null,'启用费用面板开关');costEnableButton.title='仅修改 ph-toolbar-overrides 功能 Cookie，有效1天；保留登录状态';costEnableButton.addEventListener('click',()=>void enableCostPanel());
    const drawBox=el('section','draw'),drawHead=el('div','draw-title');drawHead.append(el('b','','自动抽卡（-防人机-）'),el('span','','New Chat 循环'));
    const drawGrid=el('div','draw-grid');
    drawInput=el('input');drawInput.type='number';drawInput.min='1';drawInput.max='100';drawInput.title='抽卡轮数（1–100）';
    drawMode=el('select');for(const [value,label] of [['quick','快速 · 随机1题'],['precise','三题 · 3题全问']]){const option=el('option',null,label);option.value=value;drawMode.append(option);}drawMode.title='识别模式：快速=随机1题；精准=3题全问';
    drawMinPulse=el('input');drawMinPulse.type='number';drawMinPulse.min='0';drawMinPulse.max='100';drawMinPulse.title='额度下限百分比；低于它就停止抽卡，0 表示不限制';
    drawGrid.append(el('label',null,'轮数'),drawInput,el('label',null,'识别模式'),drawMode,el('label',null,'额度下限%'),drawMinPulse);
    const drawOptions=el('div','draw-options');
    const keepRow=el('label','draw-option-row');drawKeepInput=el('input');drawKeepInput.type='checkbox';drawKeepInput.title='主动开启后，清晰/接近匹配的非目标模型会被归档；弱匹配不按模型筛选归档。';keepRow.append(drawKeepInput,el('span',null,'只保留所选模型（非目标归档）'));
    const keepDetails=el('details','keep-details');keepDetails.append(el('summary',null,'展开／收起保留模型列表'));
    drawKeepModelsNode=el('div','draw-keep-models');keepModelCheckboxes.clear();
    for(const name of KEEP_MODELS){const row=el('label','draw-keep-model'),cb=el('input');cb.type='checkbox';cb.value=name;cb.addEventListener('change',()=>void toggleKeepModel(name,cb.checked));row.append(cb,el('span',null,name));keepModelCheckboxes.set(name,cb);drawKeepModelsNode.append(row);}
    const followRow=el('label','draw-option-row');drawFollowUp=el('input');drawFollowUp.type='checkbox';drawFollowUp.title='弱匹配时补问剩余题目；仍弱匹配则发鹈鹕 SVG，随后进行下一轮';followRow.append(drawFollowUp,el('span',null,'追问弱匹配（仍弱则发SVG）'));
    keepDetails.append(drawKeepModelsNode);
    const thinkRow=el('label','draw-option-row');thinkRow.append(el('span',null,'think 处理'));
    drawThinkMode=el('select','draw-think-mode');
    for(const [value,label] of [['keep_skip','保留并跳过'],['archive_skip','归档并跳过（默认）'],['pause','暂停']]){const option=el('option',null,label);option.value=value;drawThinkMode.append(option);}
    thinkRow.append(drawThinkMode);
    drawOptions.append(keepRow,keepDetails,thinkRow,followRow);
    drawStartButton=el('button','primary','开始抽卡');drawStopButton=el('button','stop','停止抽卡');drawStartButton.setAttribute('aria-label','开始抽卡');drawStopButton.setAttribute('aria-label','停止抽卡');
    const drawActions=el('div','draw-actions');drawActions.append(drawStartButton,drawStopButton);
    const drawMinor=el('div','draw-minor');diagnoseButton=el('button',null,'自检（只检查，不发送）');drawMinor.append(diagnoseButton);
    drawProgressNode=el('p','draw-note');drawResultsNode=el('div','results');keepSyncNode=el('p','draw-note');
    drawProgressNode.setAttribute('role','status');drawBox.append(drawHead,drawGrid,drawOptions,keepSyncNode,drawProgressNode,drawActions,drawMinor,drawResultsNode);
    const balanceBox=el('section','balance'),balanceRow=el('div','balance-row');balanceNode=el('b','','—');balanceButton=el('button',null,'刷新额度');balanceButton.title='重新读取每日额度';balanceRow.append(el('span',null,'每日额度剩余'),balanceNode,balanceButton);balanceNote=el('p','balance-note','额度来自 arena.ai/api/me/pulse（百分比）');balanceBox.append(balanceRow,balanceNote);
    const byline=el('p','byline','v1.0，by hhhhhhhh · 基于 Perkica 原版 · 本机评分，不保存聊天正文');
    body.append(warning,controls,minor,progressNode,resultNode,levelHelp,priceButton,costEnableButton,priceNode,timelineDetails,drawBox,balanceBox,byline);
    const compact=el('div','compact');compactText=el('div','compact-text','模型探测');const expand=el('button','expand','↗');expand.title='展开';expand.setAttribute('aria-label','展开浮窗');expand.addEventListener('click',()=>{collapsed=false;paint();panelControl?.persist();});compact.append(mark.cloneNode(true),compactText,expand);
    runOneButton.addEventListener('click',()=>void run('quick'));runAllButton.addEventListener('click',()=>void run('precise'));appendButton.addEventListener('click',()=>void run('quick'));stopButton.addEventListener('click',()=>{if(draw.running)stopDraw();else stop();});clearButton.addEventListener('click',clearCurrent);
    drawStartButton.addEventListener('click',()=>void runDraw(Number(drawInput.value),{mode:drawMode.value,minPulse:Number(drawMinPulse.value)}));
    drawStopButton.addEventListener('click',stopDraw);
    diagnoseButton.addEventListener('click',()=>void diagnose());
    balanceButton.addEventListener('click',()=>void refreshBalance(true));
    drawInput.addEventListener('change',()=>void savePrefs({rounds:Number(drawInput.value)}));
    drawMode.addEventListener('change',()=>void savePrefs({mode:drawMode.value}));
    drawMinPulse.addEventListener('change',()=>void savePrefs({minPulse:Number(drawMinPulse.value)}));
    drawThinkMode.addEventListener('change',()=>void savePrefs({thinkMode:drawThinkMode.value}));
    drawKeepInput.addEventListener('change',()=>void savePrefs({keepOnly:drawKeepInput.checked}));
    drawFollowUp.addEventListener('change',()=>void savePrefs({followUp:drawFollowUp.checked}));
    const extraStyle=el('style');extraStyle.textContent='.draw-options{display:flex;flex-direction:column;gap:5px;margin-top:6px;font-size:9px;color:#9eb7b0}.draw-option-row{display:flex;align-items:center;gap:5px;cursor:pointer}.draw-option-row input[type=checkbox]{width:12px;height:12px;flex:none}.draw-think-mode{max-width:175px;background:#0d1714;color:#dff3e9;border:1px solid #466257;border-radius:6px;padding:3px}.keep-details{border:1px solid #35544a;border-radius:6px;padding:3px 7px}.keep-details summary{cursor:pointer;color:#bfead5}.draw-keep-models{display:grid;grid-template-columns:1fr 1fr;gap:2px 6px;margin:2px 0 2px 17px}.draw-keep-model{display:flex;align-items:center;gap:4px;cursor:pointer;overflow:hidden;white-space:nowrap}.draw-keep-model input[type=checkbox]{width:11px;height:11px;flex:none}.draw-keep-model span{overflow:hidden;text-overflow:ellipsis}';
    box.append(head,body,compact);root.append(style,extraStyle,box);document.documentElement.append(host);paint();panelControl=globalThis.ArenaPanelRuntime.attach(host,[head,compact],{isCollapsed:()=>collapsed,restoreCollapsed:value=>{collapsed=value;paint();}});
  }
  function paint(){
    if(!agentPage()){if(host){host.hidden=true;host.style.display='none';}return;}if(!host?.isConnected)createHud();host.hidden=hudUserHidden;host.style.display=hudUserHidden?'none':'';
    const body=root.querySelector('.body'),head=root.querySelector('.head'),compact=root.querySelector('.compact');body.hidden=collapsed;head.hidden=collapsed;compact.hidden=!collapsed;
    const state=publicStatus(),samples=state.samples||0,busy=state.running;
    runOneButton.disabled=busy||samples>=3;runAllButton.disabled=busy||samples>=3;stopButton.disabled=!busy;
    appendButton.disabled=busy||samples===0||samples>=3;
    appendButton.textContent=samples>=3?'3 题已问完':`再补 1 题（已 ${samples}/3）`;
    clearButton.disabled=busy||(!samples&&!state.result);
    runOneButton.textContent=busy?'运行中…':'快速识别 · 随机1题';runAllButton.textContent=busy?'运行中…':'三题核验 · 3题全问';progressNode.textContent=state.progress||progress;
    if(state.result){resultNode.hidden=false;resultNode.dataset.level=state.result.status;resultModel.textContent=state.result.nearest.display_name;resultBadge.textContent=priceRuntime.label(state.result.evidence);resultReason.textContent=state.result.evidence?.reason||'证据尚未整理';resultNode.dataset.evidence=state.result.evidence?.status||'pending';resultMetrics.textContent=`指纹 ${{clear:'清晰',close:'接近',weak:'弱匹配'}[state.result.status]||'未知'} · 拟合 ${Number(state.result.signals.fit).toFixed(3)} · 分离 ${Number(state.result.signals.separation).toFixed(3)} · 有效 ${state.result.used_outputs}/${samples}`;resultBank.textContent=`${state.result.bank_source} · ${state.result.bank_models} 个候选 · ${(state.result.probe_results||[]).map(p=>`${p.expected_count}题: ${p.display_name||"无效"}`).join(" / ")}`;compactText.textContent=`${resultBadge.textContent} · ${state.result.nearest.display_name}`;}
    else{resultNode.hidden=true;compactText.textContent=state.draw.running?`抽卡 ${state.draw.round}/${state.draw.total}`:samples?`已捕获 ${samples}/3 条`:'模型探测';}
    const focused=root.activeElement;
    if(focused!==drawInput)drawInput.value=String(state.prefs.rounds);
    if(focused!==drawMode)drawMode.value=String(state.prefs.mode||'quick');
    if(focused!==drawMinPulse)drawMinPulse.value=String(state.prefs.minPulse);
    drawThinkMode.value=state.prefs.thinkMode;
    drawKeepInput.checked=!!state.prefs.keepOnly;
    drawKeepInput.title='勾选保留模型并开启此开关后，非目标候选须三题有效、无冲突才归档';
    drawFollowUp.checked=!!state.prefs.followUp;
    const checked=new Set((state.prefs.manualKeepModels||[]).map(normalizeName));
    for(const [name,cb] of keepModelCheckboxes){cb.checked=checked.has(normalizeName(name));cb.disabled=busy;}
    drawStartButton.disabled=busy;drawStopButton.disabled=!state.draw.running;
    drawStartButton.textContent=state.draw.running?'抽卡进行中…':busy?'识别进行中…':'开始抽卡';
    drawStartButton.title=busy?'当前任务正在运行，可先点击停止':'按当前轮数、模式和额度下限开始';
    drawInput.disabled=busy;drawMode.disabled=busy;drawMinPulse.disabled=busy;diagnoseButton.disabled=busy;drawThinkMode.disabled=busy;drawKeepInput.disabled=busy;drawFollowUp.disabled=busy;
    drawMode.title='自动抽卡每轮使用选定的题数；非目标候选会补齐三题核验';
    drawProgressNode.textContent=state.draw.note||'每轮先暖场，再问指纹题；思维链按所选模式处理，处理失败不继续。';
    keepSyncNode.textContent=`面板已勾选 ${(state.prefs.manualKeepModels||[]).length} 个模型；${state.prefs.keepOnly?'非目标候选在三题有效、无冲突后归档':'未开启按模型归档'}`;
    priceButton.disabled=busy||!session();costEnableButton.disabled=busy;
    priceNode.textContent=priceRuntime.formatPrice(state.price);priceNode.style.whiteSpace='pre-line';
    timelineNode.textContent=priceRuntime.formatTimeline(state.timeline)||'读取费用后显示，未读取。';
    const entries=state.draw.results||[];
    drawResultsNode.replaceChildren(...entries.slice(0,6).map(entry=>{const row=el('div');row.append(el('span',null,`${entry.round}. ${entry.label}`),el('b',null,entry.deleted?'已归档':entry.svgSent?'已发SVG':entry.retention||entry.verdict));return row;}));
    balanceNode.textContent=state.balanceLoading?'读取中…':typeof state.balance?.pulse==='number'?pctText(state.balance.pulse):'—';
    balanceNote.textContent=state.balanceError?state.balanceError:(state.balance?.refreshedAt?`每日额度剩余 · 下次重置 ${clock(state.balance.refreshedAt)}`:'额度来自 arena.ai/api/me/pulse（百分比）');
    balanceButton.disabled=state.balanceLoading;
  }

  chrome.runtime.onMessage.addListener((message,_sender,reply)=>{
    if(message?.type==='AMP_STATUS'){reply(publicStatus());return;}
    if(message?.type==='AMP_RUN_QUICK'||message?.type==='AMP_RUN_ONE'){draw.note='';void run('quick');reply(publicStatus());return;}
    if(message?.type==='AMP_RUN_PRECISE'||message?.type==='AMP_RUN_THREE'){draw.note='';void run('precise');reply(publicStatus());return;}
    if(message?.type==='AMP_RUN_APPEND'){draw.note='';void run('quick');reply(publicStatus());return;}
    if(message?.type==='AMP_STOP'){if(draw.running)stopDraw();else stop();reply(publicStatus());return;}
    if(message?.type==='AMP_CLEAR'){reply(clearCurrent());return;}
    if(message?.type==='AMP_DRAW_START'){void runDraw(message.rounds,message.patch||{});reply(publicStatus());return;}
    if(message?.type==='AMP_DRAW_STOP'){stopDraw();reply(publicStatus());return;}
    if(message?.type==='AMP_DIAGNOSE'){void diagnose().then(text=>reply({...publicStatus(),diagnose:text}));return true;}
    if(message?.type==='AMP_PREFS_SET'){void savePrefs(message.patch||{}).then(()=>reply(publicStatus()));return true;}
    if(message?.type==='AMP_COST_ENABLE'){void enableCostPanel().then(()=>reply(publicStatus()));return true;}
    if(message?.type==='AMP_PRICE_REFRESH'){void refreshPrice().then(()=>reply(publicStatus()));return true;}
    if(message?.type==='AMP_BALANCE_REFRESH'){void refreshBalance(true).then(()=>reply(publicStatus()));return true;}
  });
  window.addEventListener('pagehide',()=>{cancelled=true;});
  window.addEventListener('popstate',paint);window.navigation?.addEventListener('navigatesuccess',paint);
  new MutationObserver(()=>{if(host&&!host.isConnected)createHud();}).observe(document,{childList:true,subtree:true});
  createHud();setInterval(()=>{if(agentPage())paint();},1000);
  const prefsReady=loadPrefs().then(()=>{paint();void refreshBalance(false);});
})();
