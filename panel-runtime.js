/* 页内浮窗布局；只保存位置和折叠偏好，不访问页面正文。 */
(() => {
  const KEY='arena.unified.panel.v1',GAP=12;
  function attach(host,handles,{isCollapsed,restoreCollapsed}){
    let drag=null,changed=false,destroyed=false,frame=0;
    // Keep the user's chosen corner and its distance from the edges. Absolute
    // coordinates alone drift into the middle when a small browser is enlarged.
    let anchor={horizontal:'right',vertical:'bottom',dx:16,dy:16};
    function place(x,y){
      const rect=host.getBoundingClientRect();
      x=Math.max(GAP,Math.min(x,Math.max(GAP,innerWidth-rect.width-GAP)));
      y=Math.max(GAP,Math.min(y,Math.max(GAP,innerHeight-rect.height-GAP)));
      Object.assign(host.style,{left:`${x}px`,top:`${y}px`,right:'auto',bottom:'auto'});
    }
    function remember(){
      const r=host.getBoundingClientRect();
      const right=Math.max(0,innerWidth-r.right),bottom=Math.max(0,innerHeight-r.bottom);
      anchor={horizontal:r.left<=right?'left':'right',vertical:r.top<=bottom?'top':'bottom',
        dx:Math.max(0,Math.round(Math.min(r.left,right))),dy:Math.max(0,Math.round(Math.min(r.top,bottom)))};
    }
    function clamp(){
      if(destroyed||host.hidden||!host.isConnected)return;
      const r=host.getBoundingClientRect();
      place(anchor.horizontal==='right'?innerWidth-r.width-anchor.dx:anchor.dx,
        anchor.vertical==='bottom'?innerHeight-r.height-anchor.dy:anchor.dy);
    }
    function schedule(){cancelAnimationFrame(frame);frame=requestAnimationFrame(clamp);}
    function persist(){
      if(destroyed)return;changed=true;
      if(!host.hidden&&host.isConnected){remember();clamp();}
      const r=host.getBoundingClientRect();
      try{chrome.storage.local.set({[KEY]:{...anchor,x:r.left,y:r.top,collapsed:!!isCollapsed()}},()=>void chrome.runtime.lastError);}catch{}
    }
    function reset(){changed=true;anchor={horizontal:'right',vertical:'bottom',dx:16,dy:16};clamp();persist();}
    const interactive=target=>target instanceof Element&&target.closest('button,input,select,textarea,a,summary');
    function down(e){
      if(e.button!==0||!e.isPrimary||interactive(e.target))return;
      changed=true;const r=host.getBoundingClientRect();drag={id:e.pointerId,x:e.clientX-r.left,y:e.clientY-r.top,handle:e.currentTarget};
      e.currentTarget.setPointerCapture(e.pointerId);host.dataset.dragging='true';e.preventDefault();e.stopPropagation();
    }
    function move(e){if(drag?.id!==e.pointerId)return;place(e.clientX-drag.x,e.clientY-drag.y);e.preventDefault();e.stopPropagation();}
    function end(e){
      if(drag?.id!==e.pointerId)return;const {handle,id}=drag;drag=null;delete host.dataset.dragging;
      if(handle.hasPointerCapture(id))handle.releasePointerCapture(id);persist();
    }
    function key(e){
      if(e.target!==e.currentTarget)return;
      const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
      if(e.key==='Home'){e.preventDefault();reset();return;}
      if(!delta)return;e.preventDefault();const r=host.getBoundingClientRect(),step=e.shiftKey?32:8;place(r.left+delta[0]*step,r.top+delta[1]*step);persist();
    }
    for(const h of handles){
      h.tabIndex=0;h.title='拖动标题移动；方向键微调，Home 复位';
      h.setAttribute('aria-label','模型探测浮窗。可拖动；聚焦后用方向键移动，Home 复位');
      h.addEventListener('pointerdown',down);h.addEventListener('pointermove',move);h.addEventListener('pointerup',end);h.addEventListener('pointercancel',end);h.addEventListener('lostpointercapture',end);h.addEventListener('keydown',key);
    }
    const resize=new ResizeObserver(schedule);resize.observe(host);window.addEventListener('resize',schedule);clamp();
    try{chrome.storage.local.get(KEY,items=>{
      void chrome.runtime.lastError;if(destroyed||changed)return;const value=items?.[KEY];
      if(!value)return;
      restoreCollapsed(!!value.collapsed);
      if(['left','right'].includes(value.horizontal)&&['top','bottom'].includes(value.vertical)&&
         Number.isFinite(value.dx)&&Number.isFinite(value.dy)&&value.dx>=0&&value.dy>=0){
        anchor={horizontal:value.horizontal,vertical:value.vertical,dx:value.dx,dy:value.dy};clamp();
      }else if(Number.isFinite(value.x)&&Number.isFinite(value.y)){
        // Old saved {x,y}: restore once and migrate to a corner on the next save.
        place(value.x,value.y);remember();
      }
    });}catch{}
    return Object.freeze({persist,reset,clamp,destroy(){
      destroyed=true;resize.disconnect();window.removeEventListener('resize',schedule);cancelAnimationFrame(frame);
      for(const h of handles){h.removeEventListener('pointerdown',down);h.removeEventListener('pointermove',move);h.removeEventListener('pointerup',end);h.removeEventListener('pointercancel',end);h.removeEventListener('lostpointercapture',end);h.removeEventListener('keydown',key);}
    }});
  }
  globalThis.ArenaPanelRuntime=Object.freeze({attach});
})();
