'use strict';
(() => {
  const M=window.MM,E=M.esc,api=M.library;
  let ctx={},stats=null,statsError='',loadedKey='',pendingKey='',listError='',result=null,currentId='',requestNo=0;
  let filters={q:'',category:'',kind:'',contest:'',year:'',availability:'',page:1,pageSize:18};
  const cache=new Map(),errors=new Map(),pending=new Set(),versions=new Map();
  let jobs={active:0,items:[]},jobsBusy=false,jobsFetched=0,jobsTimer=null;
  const statusLabels={queued:'等待解析',parsing:'正在解析',ready:'解析完成',partial:'部分解析',needs_ocr:'需 OCR',saved_only:'仅保存原件',error:'解析失败'};
  const isActive=item=>['queued','parsing'].includes(item.ingestion?.status);
  const onKnowledge=()=>location.hash.slice(1).split('/')[0]==='knowledge';
  const tag=(s,t='')=>`<span class="badge ${t}">${E(s)}</span>`;
  const button=(action,label,extra='',style='')=>`<button type="button" class="btn small ${style}" data-kb="${action}" ${extra}>${label}</button>`;
  const url=id=>'#knowledge/'+encodeURIComponent(id);
  const formatCase=key=>{const [contest,year,p]=key.split(':');return `${contest==='CUMCM'?'国赛':contest} ${year} ${p}题`;};
  const safeURL=url=>/^https?:\/\//i.test(url||'')?url:'';
  function notify(preserveDrafts=false){
    const drafts=[];
    if(preserveDrafts)for(const form of document.querySelectorAll('#kb-filters,#kb-classification,#global-search')){
      const record=form.elements.namedItem('resourceId')?.value||'';
      for(const el of form.querySelectorAll('input:not([type="hidden"]),select,textarea'))drafts.push({form:form.id,name:el.name,record,value:el.value,restoreValue:form.id!=='kb-classification'||el.value!==[...el.options].find(o=>o.defaultSelected)?.value,focus:el===document.activeElement,start:el.selectionStart,end:el.selectionEnd});
    }
    ctx.render?.();
    for(const d of drafts){const form=document.getElementById(d.form),el=form?.elements.namedItem(d.name);if(!el||(form.elements.namedItem('resourceId')?.value||'')!==d.record)continue;if(d.restoreValue)el.value=d.value;if(d.focus){el.focus({preventScroll:true});if(d.start!==null&&d.start!==undefined)el.setSelectionRange(d.start,d.end);}}
  }
  function invalidate(id){cache.delete(id);errors.delete(id);versions.set(id,(versions.get(id)||0)+1);}
  function options(items,value,label){return `<option value="">${label}</option>`+items.map(x=>`<option value="${E(x)}" ${String(x)===String(value)?'selected':''}>${E(x)}</option>`).join('');}
  function heading(title,description,actions=''){return `<div class="page-head"><div><div class="eyebrow">KNOWLEDGE HUB</div><h1>${E(title)}</h1><p class="subhead">${E(description)}</p></div><div class="actions">${actions}</div></div>`;}
  function renderCard(item){return `<article class="kb-card"><div class="kb-card-top">${tag(item.kind)}${tag(item.availability,item.availability==='本地正文'||item.pdf?'green':'')}${item.ingestion?tag(statusLabels[item.ingestion.status]||item.ingestion.status,item.ingestion.status==='ready'?'green':''):''}${item.ingestion?.needsReview?tag('分类待确认','amber'):''}</div><h2><a href="${url(item.id)}">${E(item.title)}</a></h2><p class="kb-excerpt">${E(item.summary||'查看资料详情、来源与相关附件。')}</p><div class="kb-tags">${(item.tags||[]).slice(0,3).map(t=>`<span>${E(t)}</span>`).join('')}</div><div class="kb-card-foot"><span>${E([item.contest==='CUMCM'?'国赛':item.contest,item.year,item.problem?item.problem+'题':''].filter(Boolean).join(' · ')||item.category)}</span><a href="${url(item.id)}" class="kb-read">阅读资料 <span aria-hidden="true">→</span></a></div></article>`;}
  function queueView(){return jobs.items.length?`<section class="panel kb-upload-results" aria-label="最近上传与解析"><div class="section-head"><h2>最近上传与解析</h2>${tag(jobs.active?jobs.active+' 份等待或解析中':'处理状态已更新',jobs.active?'':'green')}</div>${jobs.items.slice(0,5).map(item=>`<div class="kb-job-row"><div><a href="${url(item.id)}">${E(item.title)}</a><small>${E(item.category)} · ${E(item.ingestion.message||'原件已保存，正文将在后台解析。')}</small></div><div>${tag(statusLabels[item.ingestion.status]||item.ingestion.status,item.ingestion.status==='ready'?'green':'')}${item.ingestion.needsReview?tag('分类待确认','amber'):''}</div></div>`).join('')}<p class="field-note">显示最近 5 项；上传后可直接离开页面，服务保持运行即可继续解析。</p></section>`:'';}
  function ingestionView(item){const ing=item.ingestion;if(!ing)return '';return `<section class="panel kb-ingestion" aria-label="自动入库结果"><div class="section-head"><h2>自动入库结果</h2>${tag(statusLabels[ing.status]||ing.status,ing.status==='ready'?'green':'')}</div><p>${E(ing.message||'原件已保存，等待后台解析。')}${ing.charCount?' · '+ing.charCount.toLocaleString('zh-CN')+' 字':''}</p><p class="field-note">${E(ing.reason)}${ing.format==='pdf'&&ing.charCount?' 自动提取的正文用于阅读与搜索，公式和版式请以 PDF 原件为准。':''}</p><form id="kb-classification" class="kb-classification"><input type="hidden" name="resourceId" value="${E(item.id)}"><label for="kb-edit-category">${ing.needsReview?'请确认分类':'知识分类'}</label><select class="field" id="kb-edit-category" name="category">${M.categories.map(c=>`<option ${c===item.category?'selected':''}>${E(c)}</option>`).join('')}</select><button class="btn small" type="submit">${ing.needsReview?'确认分类':'保存分类'}</button>${['error','partial','ready'].includes(ing.status)?button('reparse','重新解析',`data-id="${E(item.id)}"`):''}</form></section>`;}
  function legacy(){const rows=ctx.legacy?.()||[];return rows.length?`<details class="panel kb-legacy"><summary>浏览器中原有资料（${rows.length}）</summary><div class="kb-legacy-list">${rows.map(r=>`<div><strong>${E(r.name)}</strong><button class="btn small" data-action="view-resource" data-id="${E(r.id)}">查看</button><button class="btn small" data-action="download-resource" data-id="${E(r.id)}">下载</button></div>`).join('')}</div></details>`:'';}
  function listView(){
    const categories=stats?.categories||M.categories.map(name=>({name,count:0})),ready=result&&loadedKey===JSON.stringify(filters),items=ready?result.items:[];
    return heading('本地知识库','按原有六类浏览，从知识卡走向赛题、论文与实践。',button('refresh','刷新目录')+'<button class="btn primary" data-action="import-knowledge">＋ 导入资料</button>')+
    `<section class="kb-overview" aria-label="知识库概况"><div><strong>${stats?.total??'—'}</strong><span>资料记录</span></div><div><strong>${stats?.cardCount??'—'}</strong><span>可读正文</span></div><div><strong>${stats?.pdfCount??'—'}</strong><span>本地 PDF</span></div><div><strong>${stats?.problemCount??'—'}</strong><span>赛题关联入口</span></div><p>知识卡、原件与索引分别标明；记录数包含资料入口与外部索引。</p></section>
    ${queueView()}<div class="resource-layout kb-layout"><aside class="category-list kb-categories" aria-label="知识分类"><div class="kb-nav-title">分类导航</div><button class="category-btn ${!filters.category?'active':''}" data-kb="category" data-value="" aria-pressed="${!filters.category}">全部资料 <span>${stats?.total??'—'}</span></button>${categories.map(c=>`<button class="category-btn ${filters.category===c.name?'active':''}" data-kb="category" data-value="${E(c.name)}" aria-pressed="${filters.category===c.name}">${E(c.name)} <span>${c.count}</span></button>`).join('')}<div class="kb-nav-note">赛题 → 论文 → 代码 → 讲评<br>在资料详情查看关联阅读</div></aside><section class="kb-results" aria-label="资料列表"><form id="kb-filters" class="kb-filter-panel"><div class="kb-search"><input class="field" type="search" maxlength="160" name="q" aria-label="搜索知识库" value="${E(filters.q)}" placeholder="搜索标题、方法、标签或正文…"><button class="btn primary" type="submit">搜索</button></div><div class="kb-filter-row"><select name="kind" class="field" aria-label="资料类型">${options(stats?.kinds.map(x=>x.name)||[],filters.kind,'全部类型')}</select><select name="contest" class="field" aria-label="竞赛类别">${options(stats?.contests||[],filters.contest,'全部竞赛')}</select><select name="year" class="field" aria-label="竞赛年份">${options(stats?.years||[],filters.year,'全部年份')}</select><select name="availability" class="field" aria-label="内容形式">${options(['本地正文','PDF原件','题目入口','在线索引','附件包'],filters.availability,'全部内容形式')}</select>${button('reset','清除筛选')}</div><p class="kb-filter-help">关键词匹配已整理或解析的正文；扫描件尚未进行 OCR。</p></form>
    ${(statsError||listError)?`<div class="notice amber" role="alert">${E(listError||statsError)} ${button('refresh','重试')}</div>`:''}
    <div class="kb-result-bar" aria-live="polite"><strong>${E(filters.category||'全部资料')}</strong><span>${ready?`${result.total} 条记录 · 第 ${result.page} / ${result.pages} 页`:'正在读取本地目录…'}</span></div>
    ${ready?(items.length?`<div class="kb-grid">${items.map(renderCard).join('')}</div>`:`<div class="panel kb-empty"><h2>没有匹配的资料</h2><p>尝试其他关键词，或清除当前筛选。</p>${button('reset','显示全部资料')}</div>`):`<div class="panel kb-loading" role="status">${listError?'目录暂时无法打开':'正在准备资料卡片…'}</div>`}
    ${ready&&result.pages>1?`<nav class="kb-pagination" aria-label="资料分页">${button('page','← 上一页',`data-value="${result.page-1}" ${result.page<=1?'disabled':''}`)}<span>第 ${result.page} / ${result.pages} 页</span>${button('page','下一页 →',`data-value="${result.page+1}" ${result.page>=result.pages?'disabled':''}`)}</nav>`:''}${legacy()}</section></div>`;
  }
  function relatedView(item){
    const groups=[['赛题与题目入口',r=>r.kind==='赛题'],['优秀论文',r=>r.kind==='论文'],['代码与方法实践',r=>r.kind==='代码'],['讲评与其他阅读',r=>!['赛题','论文','代码'].includes(r.kind)]];
    return `<section class="kb-related panel" id="kb-related"><div class="section-head"><h2>关联阅读</h2><span class="badge green">${item.related.length} 条</span></div><p class="field-note">按明确的竞赛、年份、题号或相同方法关联。代码中的示范方案需自行验证。</p>${item.related.length?groups.map(([name,test])=>{const rows=item.related.filter(test);return rows.length?`<div class="kb-related-group"><h3>${name} <small>${rows.length}</small></h3>${rows.map(r=>`<a class="kb-related-row" href="${url(r.id)}"><div><strong>${E(r.title)}</strong><small>${E(r.availability)} · ${E(r.basis)}</small></div><span aria-hidden="true">↗</span></a>`).join('')}</div>`:'';}).join(''):'<p class="kb-muted">尚无已核实的关联条目。</p>'}</section>`;
  }
  function readerView(id){
    const item=cache.get(id);if(!item)return heading('资料阅读','')+`<div class="panel kb-empty"><p>${E(errors.get(id)||'正在打开资料…')}</p>${button('back','← 返回知识库')}${errors.has(id)?button('retry','重新打开',`data-id="${E(id)}"`):''}</div>`;
    const pdfs=item.assets.filter(a=>a.mime==='application/pdf'),primary=pdfs.find(a=>a.role==='primary'),source=safeURL(item.sourceURL);
    return `<nav class="kb-reader-breadcrumb" aria-label="阅读路径">${button('back','← 返回目录')}<span>/</span><button class="kb-text-button" data-kb="category" data-value="${E(item.category)}">${E(item.category)}</button><span>/</span><span>${E(item.kind)}</span></nav>
    <header class="kb-reader-head"><div class="kb-card-top">${tag(item.kind)}${tag(item.availability,item.availability==='本地正文'||primary?'green':'')}${item.problemKeys.map(k=>tag(formatCase(k))).join('')}</div><h1>${E(item.title)}</h1><div class="kb-reader-meta">${E(item.sourceLabel)}${item.method?' · '+E(item.method):''}</div><div class="kb-tags">${item.tags.map(t=>`<span>${E(t)}</span>`).join('')}</div></header>
    <div class="kb-reader-layout"><article class="kb-reading-main">
    ${ingestionView(item)}
    ${item.note?`<div class="kb-editor-note"><strong>资料说明</strong><p>${E(item.note)}</p></div>`:''}
    ${item.bodyHTML?`<section class="panel kb-article"><div class="kb-prose ${item.kind==='赛题'?'kb-problem-text':''}" id="kb-prose">${item.bodyHTML}</div></section>`:!primary?`<section class="panel kb-index"><h2>${item.availability==='题目入口'?'赛题资料入口':'资料索引'}</h2><p>${E(item.summary||'此条记录保留来源信息。')}</p>${source?`<a class="btn primary" href="${E(source)}" target="_blank" rel="noopener noreferrer">前往原始来源 ↗</a>`:'<p class="kb-muted">完整内容请通过下方附件或关联资料查看。</p>'}</section>`:''}
    ${pdfs.length?`<section class="panel kb-pdf-section"><div class="section-head"><h2>PDF 阅读</h2><select class="field" id="kb-pdf-select" aria-label="选择 PDF 附件">${pdfs.map(a=>`<option value="${E(a.id)}" ${a.id===primary?.id?'selected':''}>${E(a.name)}</option>`).join('')}</select></div><iframe class="kb-pdf" id="kb-pdf-frame" title="PDF 资料预览" src="/pdf-viewer.html?asset=${encodeURIComponent((primary||pdfs[0]).id)}"></iframe><p class="field-note">原件在本地加载；可翻页、缩放或下载。扫描件保留原页图像。</p></section>`:''}
    <section class="panel kb-attachments" id="kb-attachments"><div class="section-head"><h2>附件与来源</h2><span class="badge">${item.assets.length} 个本地附件</span></div>${item.assets.length?item.assets.map(a=>`<div class="kb-attachment"><span class="kb-attachment-icon">${a.mime==='application/pdf'?'PDF':E(a.name.split('.').pop().toUpperCase().slice(0,5))}</span><div><strong>${E(a.name)}</strong><small>${M.prettySize(a.size)} · ${a.role==='primary'?'资料原件':a.role==='source'?'来源页面':'相关附件'}</small></div><a class="btn small" href="${api.assetURL(a.id)}" download>下载</a></div>`).join(''):'<p class="kb-muted">当前条目没有本地原件。</p>'}${source?`<a class="kb-source-link" href="${E(source)}" target="_blank" rel="noopener noreferrer">查看原始来源 ↗</a>`:''}</section>${relatedView(item)}</article>
    <aside class="kb-reading-aside"><div class="panel kb-toc"><div class="eyebrow">ON THIS PAGE</div><h2>阅读导航</h2><nav id="kb-toc" aria-label="正文目录"></nav>${pdfs.length?button('jump','PDF 阅读','data-target="kb-pdf-frame"'):''}${button('jump','附件与来源','data-target="kb-attachments"')}${button('jump','关联阅读','data-target="kb-related"')}<div class="kb-reading-tip">${primary?'PDF 原文可直接预览':item.bodyHTML?'公式与代码可直接阅读':'此条为入口或索引'}<br>附件保留原始文件</div></div></aside></div>`;
  }
  async function loadList(){const key=JSON.stringify(filters);if(loadedKey===key||pendingKey===key)return;pendingKey=key;listError='';const sequence=++requestNo;try{const data=await api.list({...filters});if(sequence===requestNo){result=data;filters.page=data.page;loadedKey=JSON.stringify(filters);}}catch(e){if(sequence===requestNo){listError=e.message;loadedKey=key;result={items:[],total:0,page:1,pages:1};}}finally{if(sequence===requestNo){pendingKey='';if(!currentId)notify(true);}}}
  async function loadReader(id){if(cache.has(id)||pending.has(id)||errors.has(id))return;pending.add(id);const version=versions.get(id)||0;try{const item=await api.get(id);if(version===(versions.get(id)||0))cache.set(id,item);}catch(e){if(version===(versions.get(id)||0))errors.set(id,e.message);}finally{pending.delete(id);if(currentId===id&&onKnowledge())notify(true);}}
  async function loadJobs(force=false){
    if(jobsBusy||!force&&Date.now()-jobsFetched<1500)return;jobsBusy=true;
    try{const data=await api.ingestion(),old=new Map(jobs.items.map(x=>[x.id,JSON.stringify(x)])),changed=data.items.filter(x=>old.get(x.id)!==JSON.stringify(x));jobs=data;jobsFetched=Date.now();
      const readingId=currentId,reading=cache.get(readingId),refreshReading=onKnowledge()&&reading&&(isActive(reading)||changed.some(x=>x.id===readingId));let readingChanged=false;
      for(const item of changed)if(item.id!==readingId||!reading)invalidate(item.id);
      if(refreshReading){const version=versions.get(readingId)||0,fresh=await api.get(readingId);if(version===(versions.get(readingId)||0)){readingChanged=JSON.stringify(reading)!==JSON.stringify(fresh);cache.set(readingId,fresh);}}
      if(changed.length||readingChanged){loadedKey='';stats=await api.stats();if(onKnowledge()&&(!currentId||currentId===readingId&&readingChanged||!reading&&changed.some(x=>x.id===currentId)))notify(true);}
    }catch{}finally{jobsBusy=false;clearTimeout(jobsTimer);if((jobs.active||isActive(cache.get(currentId)||{}))&&onKnowledge())jobsTimer=setTimeout(()=>loadJobs(true),2200);}
  }
  async function refresh(){loadedKey='';pendingKey='';listError='';statsError='';try{stats=await api.stats();}catch(e){statsError=e.message;}if(currentId)invalidate(currentId);await loadJobs(true);notify();}
  function apply(values,clear=false){filters={...(clear?{q:'',category:'',kind:'',contest:'',year:'',availability:'',pageSize:18}:filters),...values,page:values.page||1};currentId='';ctx.go('knowledge');notify();}
  document.addEventListener('submit',async e=>{if(!['kb-filters','global-search','kb-classification'].includes(e.target.id))return;e.preventDefault();e.stopImmediatePropagation();const form=new FormData(e.target);
    if(e.target.id==='kb-classification'){const b=e.submitter;if(b)b.disabled=true;try{await api.update(form.get('resourceId'),{category:form.get('category')});await refresh();ctx.toast('分类已确认，后续解析会保留你的选择。');}catch(err){ctx.toast(err.message,true);}finally{if(b?.isConnected)b.disabled=false;}return;}
    if(e.target.id==='global-search')apply({q:String(form.get('query')||'').trim()},true);else apply(Object.fromEntries(form));});
  document.addEventListener('change',e=>{
    if(e.target.closest('#kb-filters')&&e.target.tagName==='SELECT')apply(Object.fromEntries(new FormData(e.target.form)));
    if(e.target.id==='kb-pdf-select'){const frame=document.querySelector('#kb-pdf-frame');if(frame)frame.src='/pdf-viewer.html?asset='+encodeURIComponent(e.target.value);}
  });
  document.addEventListener('click',e=>{const target=e.target.closest('[data-kb]');if(!target)return;e.preventDefault();e.stopImmediatePropagation();const {kb,value,id}=target.dataset;
    if(kb==='category')apply({category:value},true);
    if(kb==='reset')apply({},true);
    if(kb==='page'){apply({page:Number(value)});document.querySelector('.kb-results')?.scrollIntoView({block:'start'});}
    if(kb==='back'){currentId='';ctx.go('knowledge');}
    if(kb==='refresh')refresh();
    if(kb==='retry'){errors.delete(id);notify();}
    if(kb==='reparse'){target.disabled=true;api.reparse(id).then(()=>refresh()).catch(e=>ctx.toast(e.message,true)).finally(()=>{if(target.isConnected)target.disabled=false;});}
    if(kb==='jump')document.getElementById(target.dataset.target)?.scrollIntoView({behavior:'smooth',block:'start'});
  });
  window.LibraryUI={bind:config=>{ctx=config;},init:refresh,refresh,total:()=>stats?.total||0,
    view:id=>{currentId=id||'';return id?readerView(id):listView();},
    hydrate(id){loadJobs();if(id){loadReader(id);const prose=document.querySelector('#kb-prose');if(prose)window.LibraryReader?.enhance(prose);}else loadList();},
    get:id=>cache.get(id)
  };
})();
