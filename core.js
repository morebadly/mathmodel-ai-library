/* MathModel AI — browser-local domain and persistence layer. No seed records. */
'use strict';
window.MM = (() => {
  const categories = ['数学建模理论','历年竞赛题目','优秀数学建模论文','算法与代码','论文规范与评价','教学与训练'];
  const legacyCategories={'数学基础知识库':'数学建模理论','数学建模方法库':'数学建模理论','算法与编程库':'算法与代码','数学建模竞赛库':'历年竞赛题目','学术写作知识库':'论文规范与评价','教师专属知识库':'教学与训练'};
  function migrateCategories(s){for(const r of s.resources||[]){if(r.kind!=='knowledge'||!legacyCategories[r.category])continue;const old=r.category;r.category=old==='数学建模竞赛库'&&/论文/.test(r.name)?'优秀数学建模论文':legacyCategories[old];if(old==='教师专属知识库')r.scope='教师私有';}return s;}
  const stages = ['问题理解','数据探索','模型设计','算法实现','实验验证','论文撰写','论文评价','迭代优化'];
  const dimensions = ['问题理解','模型假设','模型构建','算法实现','结果验证','论文写作','创新性'];
  const draftWeights = [15,10,20,15,15,10,15]; // Source proposal, p.13; editable, never a score.
  const modes = ['基础解释','方法探索','分步指导','深度研究'];
  const uid = () => globalThis.crypto?.randomUUID?.() || 'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  const now = () => new Date().toISOString();
  const blank = () => ({schemaVersion:1,projects:[],resources:[],papers:[],tasks:[],competitions:[],conversations:[],events:[],settings:{role:'学生视图',provider:'ollama',endpoint:'',model:'',weights:[...draftWeights]}});
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const prettySize = n => n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
  const date = s => s ? new Date(s).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}) : '未设置';
  const fullDate = s => s ? new Date(s).toLocaleString('zh-CN',{hour12:false}) : '未设置';
  const progress = p => Math.round((p.stages?.filter(s=>s.done).length || 0)/stages.length*100);
  const makeProject = (title, description='', extra={}) => ({id:uid(),title,description,createdAt:now(),updatedAt:now(),stages:stages.map(title=>({title,content:'',done:false})),resourceIds:[],...extra});
  const isText = name => /\.(txt|md|markdown|tex|csv|tsv|json|py|m|r|js|html|css|srt|vtt|bib)$/i.test(name);
  const fileExt = name => name.split('.').pop().toUpperCase();
  const searchable = r => [r.name,r.description,r.tags,r.category,r.text].join(' ').toLowerCase();
  function searchResources(resources, query, category='', scope='') {
    const tokens=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return resources.filter(r=>r.kind==='knowledge' && (!category||r.category===category) && (!scope||r.scope===scope) && tokens.every(t=>searchable(r).includes(t)));
  }
  function retrieve(resources, query) {
    const clean=query.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ');
    const tokens=[...new Set([...clean.split(/\s+/).filter(Boolean),...(clean.match(/[\u3400-\u9fff]{2,}/g)||[]).flatMap(s=>Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)))])];
    return resources.filter(r=>r.kind==='knowledge'&&r.scope!=='教师私有'&&r.text).map(r=>({resource:r,score:tokens.reduce((n,t)=>n+(searchable(r).includes(t)?t.length:0),0)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,4);
  }
  function inspectText(text, name) {
    const lines=text.split(/\r?\n/), findings=[];
    const add=(level,title,detail,line)=>findings.push({level,title,detail,line});
    if(!text.trim()) return [{level:'info',title:'尚无可检查的文本',detail:'请上传 TXT、Markdown、LaTeX 文本，或手动补充原文。'}];
    const sections=[['摘要',/摘要|abstract/i],['模型假设',/假设|assumption/i],['模型建立',/模型建立|模型构建|模型设计|model formulation|\\section\{[^}]*模型/i],['结果验证',/敏感性|鲁棒性|验证|sensitivity|validation/i],['参考文献',/参考文献|references|\\bibliography|\\printbibliography/i]];
    for(const [title,pattern] of sections){const i=lines.findIndex(l=>pattern.test(l));add(i>=0?'pass':'info',title,i>=0?'在原文中找到相关文字；未判断内容质量。':'未检出相关关键词，请人工核对章节。',i>=0?i+1:null);}
    if(/\.tex$/i.test(name)) {
      const labels=[...text.matchAll(/\\label\{([^}]+)\}/g)].map(m=>m[1]);
      const refs=[...text.matchAll(/\\(?:eqref|ref|autoref|cref)\{([^}]+)\}/g)];
      refs.filter(m=>!labels.includes(m[1])).forEach(m=>add('warn','未找到引用目标',m[1],text.slice(0,m.index).split('\n').length));
      const stack=[];
      for(const m of text.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
        if(m[1]==='begin') stack.push(m[2]);
        else if(stack.pop()!==m[2]) add('warn','环境配对需核对',m[0],text.slice(0,m.index).split('\n').length);
      }
      if(stack.length) add('warn','存在未闭合环境',stack.join('、'));
      add('info','检查范围','本地仅检查常见文本结构、引用标签和环境配对，不执行 LaTeX 编译。');
    }
    return findings;
  }
  let db;
  const txDone = tx => new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('本地写入已取消'));});
  const request = req => new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  async function open() {
    if(!globalThis.indexedDB) throw new Error('当前浏览器不支持本地数据库，请使用 Chrome 或 Edge。');
    const req=indexedDB.open('mathmodel-ai-local-v1',1);
    req.onupgradeneeded=()=>{const d=req.result;d.createObjectStore('workspace');d.createObjectStore('files');};
    db=await request(req);
    db.onversionchange=()=>db.close();
    const t=db.transaction('workspace','readonly');return migrateCategories((await request(t.objectStore('workspace').get('state'))) || blank());
  }
  async function save(state,files=[]) { const t=db.transaction(files.length?['workspace','files']:['workspace'],'readwrite');for(const f of files)t.objectStore('files').put(f.blob,f.id);t.objectStore('workspace').put(state,'state');await txDone(t); }
  async function storeFiles(entries) {const t=db.transaction('files','readwrite');for(const x of entries)t.objectStore('files').put(x.blob,x.id);await txDone(t);}
  async function getFile(id) {return request(db.transaction('files','readonly').objectStore('files').get(id));}
  function base64(blob) {return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(',')[1]);r.onerror=()=>rej(r.error);r.readAsDataURL(blob);});}
  function unbase64(s,type) {const str=atob(s),arr=new Uint8Array(str.length);for(let i=0;i<str.length;i++)arr[i]=str.charCodeAt(i);return new Blob([arr],{type});}
  async function backup(state) {
    state=structuredClone(state);
    const files=[];
    for(const r of state.resources){const b=await window.MM.getFile(r.id);if(!b)throw new Error('附件缺失：'+r.name+'。请重新导入后备份。');files.push({id:r.id,type:b.type,data:await base64(b)});}
    return {format:'mathmodel-ai-backup',version:1,exportedAt:now(),state,files};
  }
  function validateBackup(value) {
    if(value?.state?.resources)migrateCategories(value.state);
    if(value?.format!=='mathmodel-ai-backup'||value.version!==1||value.state?.schemaVersion!==1) throw new Error('不是受支持的 MathModel AI 备份文件。');
    const s=value.state;
    for(const k of ['projects','resources','papers','tasks','competitions','conversations','events'])if(!Array.isArray(s[k]))throw new Error('备份缺少有效的 '+k+' 数据。');
    const text=x=>typeof x==='string',validId=x=>text(x)&&/^[A-Za-z0-9_-]{8,100}$/.test(x),validDate=x=>text(x)&&Number.isFinite(Date.parse(x));
    if(!s.settings||!Array.isArray(value.files))throw new Error('备份配置不完整。');
    const cfg=s.settings;
    if(!['学生视图','教师视图','管理视图'].includes(cfg.role)||!['ollama','openai-compatible'].includes(cfg.provider)||!text(cfg.endpoint)||!text(cfg.model)||Object.keys(cfg).some(k=>!['role','provider','endpoint','model','weights'].includes(k)))throw new Error('服务配置字段无效。');
    if(cfg.endpoint){let u;try{u=new URL(cfg.endpoint);}catch{throw new Error('服务地址无效。');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('服务地址包含不受支持的内容。');}
    if(!Array.isArray(cfg.weights)||cfg.weights.length!==7||cfg.weights.some(n=>!Number.isFinite(n)||n<0||n>100)||cfg.weights.reduce((a,b)=>a+b,0)!==100)throw new Error('评价权重无效。');
    for(const k of ['projects','resources','papers','tasks','competitions','conversations','events']) {
      const ids=new Set();for(const x of s[k]){if(!x||!validId(x.id)||ids.has(x.id))throw new Error('备份含有缺失、重复或无效标识。');ids.add(x.id);}
    }
    const resourceIds=new Set(s.resources.map(r=>r.id)),projectIds=new Set(s.projects.map(p=>p.id)),taskIds=new Set(s.tasks.map(t=>t.id)),competitionIds=new Set(s.competitions.map(c=>c.id));
    const references=arr=>Array.isArray(arr)&&arr.every(id=>resourceIds.has(id));
    for(const p of s.projects)if(!text(p.title)||!text(p.description)||!validDate(p.createdAt)||!validDate(p.updatedAt)||!references(p.resourceIds)||!Array.isArray(p.stages)||p.stages.length!==8||p.stages.some(st=>!text(st.title)||!text(st.content)||typeof st.done!=='boolean')||(p.taskId&&!taskIds.has(p.taskId))||(p.competitionId&&!competitionIds.has(p.competitionId)))throw new Error('建模项目结构或关联无效。');
    for(const r of s.resources)if(!text(r.name)||!text(r.text)||!text(r.type)||!text(r.description)||!text(r.tags)||!Number.isInteger(r.size)||r.size<0||!validDate(r.createdAt)||!['knowledge','paper','attachment'].includes(r.kind)||!['个人资料','公开资料','校内资料','教师私有'].includes(r.scope)||(r.kind==='knowledge'&&!categories.includes(r.category)))throw new Error('资料记录无效。');
    for(const p of s.papers){
      if(!text(p.title)||!validDate(p.createdAt)||!resourceIds.has(p.fileId)||(p.projectId&&!projectIds.has(p.projectId))||!Array.isArray(p.annotations)||!Array.isArray(p.scores)||p.scores.length!==7||p.scores.some(n=>n!==null&&(!Number.isFinite(n)||n<0||n>100))||!Array.isArray(p.findings))throw new Error('论文记录不完整。');
      for(const a of p.annotations)if(!validId(a.id)||!text(a.location)||!text(a.problem)||!text(a.suggestion)||!text(a.evidence)||!validDate(a.at))throw new Error('论文批注无效。');
      for(const f of p.findings)if(!['pass','warn','info'].includes(f.level)||!text(f.title)||!text(f.detail)||(f.line!=null&&(!Number.isInteger(f.line)||f.line<1)))throw new Error('论文检查记录无效。');
    }
    for(const t of s.tasks)if(!text(t.title)||!['自由练习','引导训练'].includes(t.mode)||!text(t.requirements)||!text(t.criteria)||!references(t.attachmentIds)||!validDate(t.createdAt)||(t.dueAt&&!validDate(t.dueAt)))throw new Error('训练任务无效。');
    for(const c of s.competitions)if(!text(c.title)||!text(c.rules)||!text(c.teamName)||!text(c.members)||!['关闭 AI','仅基础知识查询','开放辅助'].includes(c.aiPolicy)||!['ready','active','completed'].includes(c.status)||!Number.isFinite(c.hours)||c.hours<=0||c.hours>720||!validDate(c.createdAt)||(c.status!=='ready'&&(!projectIds.has(c.projectId)||!validDate(c.startedAt)))||(c.status==='completed'&&!validDate(c.finishedAt)))throw new Error('模拟竞赛记录无效。');
    for(const c of s.conversations){if(!text(c.title)||!validDate(c.createdAt)||!Array.isArray(c.messages))throw new Error('对话记录无效。');for(const m of c.messages)if(!['user','assistant'].includes(m.role)||!text(m.content)||!validDate(m.at)||(m.sources&&(!Array.isArray(m.sources)||m.sources.some(x=>!resourceIds.has(x.id)||!text(x.name)))))throw new Error('对话消息无效。');}
    for(const e of s.events)if(!text(e.label)||!validDate(e.at))throw new Error('操作记录无效。');
    for(const f of value.files)if(!validId(f.id)||!resourceIds.has(f.id)||!text(f.type)||!text(f.data)||f.data.length%4!==0||! /^[A-Za-z0-9+/]*={0,2}$/.test(f.data))throw new Error('备份附件编码无效。');
    const ids=new Set(value.files.map(f=>f.id));if(ids.size!==value.files.length||s.resources.some(r=>!ids.has(r.id)))throw new Error('备份缺失附件或包含重复附件。');
    return value;
  }
  async function restore(value) {
    validateBackup(value);
    const entries=value.files.map(f=>({id:f.id,blob:unbase64(f.data,f.type)}));
    for(const e of entries)if(e.blob.size!==value.state.resources.find(r=>r.id===e.id).size)throw new Error('附件大小校验失败，原工作空间未修改。');
    // One transaction: original workspace survives any failed restoration.
    const t=db.transaction(['workspace','files'],'readwrite');
    t.objectStore('files').clear();for(const e of entries)t.objectStore('files').put(e.blob,e.id);
    t.objectStore('workspace').put(value.state,'state');await txDone(t);return value.state;
  }
  function download(content,name,type='application/json') {const b=content instanceof Blob?content:new Blob([content],{type});const url=URL.createObjectURL(b);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  return {categories,stages,dimensions,draftWeights,modes,uid,now,blank,esc,prettySize,date,fullDate,progress,makeProject,isText,fileExt,searchResources,retrieve,inspectText,open,save,storeFiles,getFile,backup,validateBackup,restore,download};
})();
