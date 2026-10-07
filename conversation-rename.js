/* Rename the current Arena conversation through Arena's visible UI only. */
(() => {
  let busy=false;
  const sessionFromPath=path=>path.match(/^\/(?:agent|work)\/([a-zA-Z0-9-]{1,128})\/?$/)?.[1]||null;
  const text=element=>(element?.textContent||'').trim();
  const exact=(element,words)=>words.includes(text(element));
  const visible=element=>{
    if(!element?.isConnected||!element.getClientRects().length)return false;
    if(['menu','dialog','alertdialog'].includes(element.getAttribute('role'))&&element.getAttribute('data-state')==='closed')return false;
    if(typeof getComputedStyle==='function'){const style=getComputedStyle(element);if(style.display==='none'||style.visibility==='hidden')return false;}
    return true;
  };
  function validate(sessionId,title){
    if(typeof sessionId!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(sessionId))throw Error('当前 Arena 会话尚未建立，无法重命名');
    if(typeof title!=='string'||!title.trim())throw Error('没有可用于重命名的模型名');
    const clean=title.trim();
    if(clean.length>100||/[\u0000-\u001f\u007f]/.test(clean))throw Error('模型名不符合 Arena 标题限制');
    return clean;
  }
  async function rename({sessionId,title,isCurrent=()=>true}){
    const nextTitle=validate(sessionId,title);
    if(busy)throw Error('会话重命名正在进行');
    const guard=()=>{if(location.origin!=='https://arena.ai'||sessionFromPath(location.pathname)!==sessionId||!isCurrent())throw Error('当前会话已变化，停止重命名');};
    const wait=(check,message,timeout=8000)=>new Promise((resolve,reject)=>{
      let observer,timer,interval,done=false;
      const finish=(error,value)=>{if(done)return;done=true;observer?.disconnect();clearTimeout(timer);clearInterval(interval);error?reject(error):resolve(value);};
      const tick=()=>{try{guard();const value=check();if(value)finish(null,value);}catch(error){finish(error);}};
      observer=new MutationObserver(tick);observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
      interval=setInterval(tick,100);timer=setTimeout(()=>finish(Error(message)),timeout);tick();
    });
    const links=()=>[...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].filter(link=>{try{const url=new URL(link.href);return url.origin==='https://arena.ai'&&sessionFromPath(url.pathname)===sessionId;}catch{return false;}});
    const currentLink=()=>links().find(link=>visible(link)&&!link.closest?.('[data-state="collapsed"][data-collapsible]'))||null;
    guard();busy=true;let menu=null,dialog=null,submitted=false,oldTitle='';
    try{
      if([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible))throw Error('页面仍有对话框，无法安全重命名');
      if(!currentLink()){
        const buttons=[...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled);
        const opener=buttons.find(button=>['Open sidebar','展开侧栏','打开侧边栏','展开侧边栏'].includes(button.getAttribute('aria-label')))
          ||buttons.find(button=>['Toggle Sidebar','Toggle sidebar','切换侧栏'].includes(button.getAttribute('aria-label'))&&button.closest?.('[data-state="collapsed"]'));
        if(opener){guard();opener.click();}
      }
      const link=await wait(currentLink,'未找到当前会话的侧栏标签，无法自动重命名');
      link.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});oldTitle=text(link);
      if(oldTitle===nextTitle)return {title:nextTitle,previousTitle:oldTitle,unchanged:true};
      const row=link.closest('[data-sidebar="menu-item"]');
      const trigger=row?.querySelector('button[data-sidebar="menu-action"][aria-haspopup="menu"]');
      if(!trigger?.id||trigger.disabled)throw Error('当前会话菜单不可用，无法自动重命名');
      const getMenu=()=>[...document.querySelectorAll('[role="menu"]')].find(element=>element.getAttribute('aria-labelledby')===trigger.id&&visible(element));
      if(!getMenu()){
        guard();
        trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0,buttons:1,isPrimary:true}));
        trigger.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0,buttons:0,isPrimary:true}));
        trigger.click();
      }
      menu=await wait(getMenu,'无法打开当前会话菜单');
      const items=[...menu.querySelectorAll('[role="menuitem"]')].filter(element=>exact(element,['Rename','重命名','重命名对话'])&&!element.hasAttribute('data-disabled'));
      if(items.length!==1)throw Error('没有找到唯一的重命名入口');
      guard();items[0].click();
      dialog=await wait(()=>[...document.querySelectorAll('[role="dialog"]')].find(element=>visible(element)&&exact(element.querySelector('h2'),['Rename chat','Rename conversation','重命名对话','重命名聊天'])),'没有出现 Arena 重命名对话框');
      const inputs=[...dialog.querySelectorAll('input')].filter(element=>visible(element)&&!element.disabled&&['text',''].includes(element.getAttribute('type')||''));
      if(inputs.length!==1)throw Error('重命名输入框不明确，未提交');
      const input=inputs[0];
      if(input.value!==oldTitle||text(currentLink())!==oldTitle)throw Error('会话标题已被其他操作修改，未提交');
      if(input.maxLength>0&&nextTitle.length>input.maxLength)throw Error('模型名超过页面允许的标题长度');
      guard();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,nextTitle);
      input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
      const submit=await wait(()=>[...dialog.querySelectorAll('button[type="submit"]')].find(button=>visible(button)&&!button.disabled&&exact(button,['Rename','重命名','保存'])),'Arena 没有接受新的会话名称');
      guard();if(input.value!==nextTitle||text(currentLink())!==oldTitle)throw Error('提交前会话标题发生变化，已取消');
      submitted=true;submit.click();
      await wait(()=>text(currentLink())===nextTitle&&!visible(dialog),'未能确认会话重命名成功',10000);
      return {title:nextTitle,previousTitle:oldTitle,unchanged:false};
    }finally{
      if(!submitted&&sessionFromPath(location.pathname)===sessionId){
        if(visible(dialog)){
          const input=dialog.querySelector('input');
          if(input&&[nextTitle,oldTitle].includes(input.value)){const cancel=[...dialog.querySelectorAll('button[type="button"]')].find(button=>exact(button,['Cancel','取消']));cancel?.click();}
        }else if(visible(menu))menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
      }
      busy=false;
    }
  }
  async function archive({sessionId,isCurrent=()=>true}){
    validate(sessionId,'archive');if(busy)throw Error('会话菜单正在使用，未归档');
    const guard=()=>{if(location.origin!=='https://arena.ai'||sessionFromPath(location.pathname)!==sessionId||!isCurrent())throw Error('当前会话已变化，停止归档');};
    const links=()=>[...document.querySelectorAll('a[data-sidebar="menu-button"][href]')].filter(link=>{try{const url=new URL(link.href);return url.origin==='https://arena.ai'&&sessionFromPath(url.pathname)===sessionId;}catch{return false;}});
    const currentLink=()=>links().find(visible)||null;
    const wait=async(check,message,timeout=8000,checkGuard=true)=>{
      const end=Date.now()+timeout;while(Date.now()<end){if(checkGuard)guard();const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(message);
    };
    guard();busy=true;let menu=null,submitted=false;
    try{
      if([...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].some(visible))throw Error('页面仍有对话框，请关闭后手动归档');
      if(!currentLink()){
        const openers=[...document.querySelectorAll('button[aria-label]')].filter(button=>visible(button)&&!button.disabled&&['Open sidebar','展开侧栏','打开侧边栏','展开侧边栏'].includes(button.getAttribute('aria-label')));
        if(openers.length===1){guard();openers[0].click();}
      }
      const link=await wait(currentLink,'未找到当前会话的侧栏标签，未归档');link.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});
      const trigger=link.closest('[data-sidebar="menu-item"]')?.querySelector('button[data-sidebar="menu-action"][aria-haspopup="menu"]');
      if(!trigger?.id||trigger.disabled)throw Error('当前会话菜单不可用，未归档');
      const getMenu=()=>[...document.querySelectorAll('[role="menu"]')].find(element=>element.getAttribute('aria-labelledby')===trigger.id&&visible(element));
      if(!getMenu()){guard();trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:0,buttons:1,isPrimary:true}));trigger.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'mouse',button:0,buttons:0,isPrimary:true}));trigger.click();}
      menu=await wait(getMenu,'无法打开当前会话菜单，未归档');
      const items=[...menu.querySelectorAll('[role="menuitem"]')].filter(item=>exact(item,['Archive','Archive chat','Archive conversation','归档','归档聊天','归档对话'])&&!item.hasAttribute('data-disabled')&&item.getAttribute('aria-disabled')!=='true');
      if(items.length!==1)throw Error('没有找到唯一的归档入口，未归档');
      guard();submitted=true;items[0].click();
      let confirmed=false;
      await wait(()=>{
        const dialog=[...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].find(element=>visible(element)&&exact(element.querySelector('h2'),['Archive chat','Archive conversation','归档聊天','归档对话','归档']));
        if(dialog&&!confirmed){
          guard();const buttons=[...dialog.querySelectorAll('button')].filter(button=>visible(button)&&!button.disabled&&exact(button,['Archive','归档','确认归档']));
          if(buttons.length!==1)throw Error('归档确认按钮不明确，请手动归档');confirmed=true;buttons[0].click();return false;
        }
        return links().length===0&&!visible(menu)&&!visible(dialog);
      },'未能确认会话归档成功，请手动检查',10000,false);
      return {sessionId,archived:true};
    }finally{
      if(!submitted&&visible(menu))menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));busy=false;
    }
  }
  globalThis.ArenaProbeRename=Object.freeze({rename,archive,isBusy:()=>busy,sessionFromPath});
})();
