'use strict';
const http=require('node:http');
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {Store}=require('./backend/store.cjs');
const {Ragflow}=require('./backend/ragflow.cjs');
const {extractHTML,strip}=require('./backend/html-text.cjs');
const {CATEGORIES,SCOPES,SUPPORTED,AppError,fields,docStatus,publicResource}=require('./backend/domain.cjs');

const MAX_FILE=1024*1024*1024;
const MIME={'.pdf':'application/pdf','.html':'text/html','.htm':'text/html','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
function localURL(value){
  let u;try{u=new URL(value);}catch{throw new AppError(400,'RAGFlow 地址无效。');}
  if(!['http:','https:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new AppError(400,'本地试运行只接受 localhost 或 127.0.0.1 的服务根地址。');
  return u.origin;
}
function readConfig(file){
  let cfg={};try{cfg=JSON.parse(fs.readFileSync(file,'utf8'));}catch(err){if(err.code!=='ENOENT')throw new Error('RAGFlow 配置文件无效，请检查本地配置。');}
  return {baseURL:localURL(cfg.baseURL||'http://127.0.0.1:9380'),apiKey:typeof cfg.apiKey==='string'?cfg.apiKey:'',embeddingModel:typeof cfg.embeddingModel==='string'?cfg.embeddingModel:'bge-m3@Ollama',namespace:typeof cfg.namespace==='string'?cfg.namespace:''};
}
async function jsonBody(req,limit=1024*1024){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new AppError(415,'此接口需要JSON请求。');
  let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>limit)throw new AppError(413,'请求内容过大。');parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new AppError(400,'JSON格式无效。');}
}
function send(res,status,data){const b=Buffer.from(JSON.stringify(data));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(b);}
function stateFor(name){const ext=path.extname(name).toLowerCase();return ['.zip','.rar','.7z'].includes(ext)?'needs_unpack':SUPPORTED.has(ext)?'queued':'unsupported';}
function chunksOf(value){return Array.isArray(value)?value:value?.chunks||[];}
function hitOf(chunk,resource){
  const explicit=chunk.page_num??chunk.page_number;const page=Array.isArray(explicit)?explicit[0]:explicit;
  return {resource:publicResource(resource),chunkId:String(chunk.id||chunk.chunk_id||''),page:Number.isInteger(Number(page))&&Number(page)>0?Number(page):null,text:strip(chunk.content||chunk.content_with_weight||''),score:Number(chunk.similarity??chunk.vector_similarity??0)};
}

function createApp({dataDir=path.join(__dirname,'.data'),staticDir=__dirname,workerInterval=5000,ragflow:providedClient}={}){
  const store=new Store(dataDir),configFile=path.join(dataDir,'ragflow.json');
  const config=()=>readConfig(configFile);
  const rag=providedClient||new Ragflow(config);
  const staticFiles=new Map([['/','index.html'],['/index.html','index.html'],['/core.js','core.js'],['/knowledge.js','knowledge.js'],['/app.js','app.js'],['/styles.css','styles.css'],['/assets/favicon.svg','assets/favicon.svg']]);
  const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
  let processing=false,closed=false,lastError='';
  async function processQueue(){
    if(processing||closed||(!providedClient&&!config().apiKey))return;
    processing=true;
    try{
      for(const original of store.list().filter(r=>r.status==='parsing')){
        if(closed)break;
        try{
          const doc=await rag.document(original.dataset_id,original.document_id);
          if(!doc)throw new AppError(502,'RAGFlow内未找到此文档，请重试解析。');
          const status=docStatus(doc);
          const err=status==='error'?strip(Array.isArray(doc.progress_msg)?doc.progress_msg.join('\n'):String(doc.progress_msg||'解析中断，请重试。')).slice(-1600):'';
          store.update(original.id,{status,error:err,chunk_count:Number(doc.chunk_count)||0},original.revision);
        }catch(err){lastError=err.message;}
      }
      const queued=store.list().find(r=>r.status==='queued');
      if(!queued||closed)return;
      try{
        store.update(queued.id,{status:'uploading',error:''},queued.revision);
        const dataset=await rag.dataset(queued.category,store);
        if(store.get(queued.id)?.revision!==queued.revision)return;
        let docId=queued.document_id;
        if(!docId||queued.dataset_id!==dataset){
          // Recover a successful upstream upload if its response was lost.
          const prior=await rag.findDocument?.(dataset,queued.id+'-'+queued.name);
          const doc=prior||await rag.upload(dataset,queued,store.file(queued));docId=doc.id;
          if(!store.update(queued.id,{dataset_id:dataset,document_id:docId},queued.revision))return;
        }
        await rag.parse(dataset,docId);
        store.update(queued.id,{status:'parsing',error:''},queued.revision);lastError='';
      }catch(err){
        lastError=err.message;
        store.update(queued.id,{status:err.status===503?'queued':'error',error:err.message},queued.revision);
      }
    }finally{processing=false;}
  }
  async function status(){
    const c=config();let connected=false,error='';
    if(c.apiKey||providedClient){try{connected=await rag.available();lastError='';}catch(err){error=err.message;}}
    else error='RAGFlow尚未配置。';
    return {configured:!!c.apiKey||!!providedClient,connected,error:error||lastError,baseURL:c.baseURL,embeddingModel:c.embeddingModel,categories:CATEGORIES,mode:'local-only',counts:store.list().reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{})};
  }
  async function upload(req,url){
    const name=url.searchParams.get('name');
    if(!name||name.length>240||/[\x00-\x1f/\\]/.test(name))throw new AppError(400,'文件名无效。');
    const values=fields(Object.fromEntries(url.searchParams));
    const limit=/\.html?$/i.test(name)?20*1024*1024:MAX_FILE;
    const declared=Number(req.headers['content-length']);
    if(Number.isFinite(declared)&&declared>limit)throw new AppError(413,'文件超过此格式的导入上限。');
    const free=fs.statfsSync(dataDir);if(Number.isFinite(declared)&&declared>0&&Number(free.bavail)*Number(free.bsize)<declared+512*1024*1024)throw new AppError(507,'本地资料目录空间不足。');
    const tmp=path.join(dataDir,'tmp',crypto.randomUUID()+'.part');
    const hash=crypto.createHash('sha256');let size=0;
    try{
      await pipeline(req,new Transform({transform(part,enc,cb){size+=part.length;if(size>limit)return cb(new AppError(413,'文件超过导入上限。'));hash.update(part);cb(null,part);}}),fs.createWriteStream(tmp,{flags:'wx'}));
      if(!size)throw new AppError(400,'不能导入空文件。');
      const sha256=hash.digest('hex');
      const duplicate=store.duplicate(sha256,values.category,values.scope);if(duplicate)return {resource:publicResource(duplicate),duplicate:true};
      let preview='';if(/\.(html?|txt|md|markdown)$/i.test(name)&&size<=20*1024*1024){const raw=await fsp.readFile(tmp,'utf8');preview=(/\.html?$/i.test(name)?extractHTML(raw):raw).slice(0,600);}
      const row={id:'kb_'+crypto.randomUUID(),name,sha256,size,mime:MIME[path.extname(name).toLowerCase()]||'application/octet-stream',...values,status:stateFor(name),preview,created_at:new Date().toISOString()};
      const destination=store.file(row);
      if(!fs.existsSync(destination)){await fsp.copyFile(tmp,destination,fs.constants.COPYFILE_EXCL).catch(err=>{if(err.code!=='EEXIST')throw err;});}
      const raced=store.duplicate(sha256,values.category,values.scope);if(raced)return {resource:publicResource(raced),duplicate:true};
      const r=store.insert(row);setImmediate(()=>processQueue().catch(()=>{}));return {resource:publicResource(r),duplicate:false};
    }finally{await fsp.unlink(tmp).catch(()=>{});}
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const host=String(req.headers.host||'');if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host))throw new AppError(403,'本地服务仅接受本机访问。');
      const url=new URL(req.url,'http://'+host);let match;
      if(!['GET','HEAD'].includes(req.method)){
        const origin=req.headers.origin;
        if(origin&&!['http://'+host,'http://127.0.0.1:'+server.address().port,'http://localhost:'+server.address().port].includes(origin))throw new AppError(403,'拒绝来自其他网页的写入请求。');
      }
      if(url.pathname==='/health'&&req.method==='GET')return send(res,200,{app:'MathModel AI',version:'1.1.0',mode:'local-ragflow',knowledgeStorage:'server-disk',otherStorage:'browser-indexeddb'});
      if(url.pathname==='/api/knowledge/status'&&req.method==='GET')return send(res,200,await status());
      if(url.pathname==='/api/knowledge/config'&&req.method==='PUT'){
        const body=await jsonBody(req);const old=config();
        if(typeof body.baseURL!=='string'||(body.apiKey!==undefined&&typeof body.apiKey!=='string'))throw new AppError(400,'服务配置字段无效。');
        const next={...old,baseURL:localURL(body.baseURL),apiKey:body.apiKey?.trim()||old.apiKey};
        if(next.apiKey.length>4096||/[\r\n]/.test(next.apiKey))throw new AppError(400,'访问密钥格式无效。');
        if(store.list().some(r=>r.document_id)&&(next.baseURL!==old.baseURL||(body.apiKey&&next.apiKey!==old.apiKey)))throw new AppError(409,'已有资料绑定当前RAGFlow，请先迁移索引后再更换服务或账户。');
        const draft=configFile+'.tmp';await fsp.writeFile(draft,JSON.stringify(next,null,2),{mode:0o600});await fsp.rename(draft,configFile);setImmediate(()=>processQueue().catch(()=>{}));
        return send(res,200,{saved:true,configured:!!next.apiKey});
      }
      if(url.pathname==='/api/knowledge/resources'&&req.method==='GET')return send(res,200,{resources:store.list().map(publicResource),categories:CATEGORIES});
      if(url.pathname==='/api/knowledge/resources'&&req.method==='POST')return send(res,201,await upload(req,url));
      if((match=url.pathname.match(/^\/api\/knowledge\/resources\/(kb_[a-zA-Z0-9-]+)(?:\/(file|chunks|retry))?$/))){
        const row=store.get(match[1]);if(!row)throw new AppError(404,'找不到此资料。');
        if(match[2]==='file'&&req.method==='GET'){
          res.writeHead(200,{'Content-Type':row.mime,'Content-Length':row.size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(row.name),'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
          return fs.createReadStream(store.file(row)).on('error',()=>res.destroy()).pipe(res);
        }
        if(match[2]==='chunks'&&req.method==='GET'){
          if(row.status!=='ready')throw new AppError(409,'资料尚未完成解析。');
          const result=await rag.chunks(row.dataset_id,row.document_id);
          return send(res,200,{hits:chunksOf(result).filter(c=>!(c.document_id||c.doc_id)||(c.document_id||c.doc_id)===row.document_id).map(c=>hitOf(c,row)),total:result.total||0});
        }
        if(match[2]==='retry'&&req.method==='POST'){
          if(['needs_unpack','unsupported'].includes(row.status))throw new AppError(400,'请先将此资料转换或解包为可解析文件。');
          const r=store.update(row.id,{status:'queued',error:'',revision:row.revision+1});setImmediate(()=>processQueue().catch(()=>{}));return send(res,200,{resource:publicResource(r)});
        }
        if(!match[2]&&req.method==='PATCH'){
          const input=await jsonBody(req);const values=fields({...row,...input});
          const duplicate=store.duplicate(row.sha256,values.category,values.scope);if(duplicate&&duplicate.id!==row.id)throw new AppError(409,'该分类和分区已存在相同原件。');
          const moved=values.category!==row.category;
          const r=store.update(row.id,{...values,revision:row.revision+(moved?1:0),...(moved?{dataset_id:null,document_id:null,status:stateFor(row.name),chunk_count:0,error:''}:{})});
          setImmediate(()=>processQueue().catch(()=>{}));return send(res,200,{resource:publicResource(r)});
        }
      }
      if(url.pathname==='/api/knowledge/retrieve'&&req.method==='POST'){
        const body=await jsonBody(req);const question=body.question;
        if(typeof question!=='string'||!question.trim()||question.length>12000)throw new AppError(400,'请输入有效的检索问题。');
        if(body.category&&!CATEGORIES.includes(body.category)||body.scope&&!SCOPES.includes(body.scope))throw new AppError(400,'检索分类或分区无效。');
        const candidates=store.list().filter(r=>r.status==='ready'&&r.document_id&&r.scope!=='教师私有'&&(!body.category||r.category===body.category)&&(!body.scope||r.scope===body.scope));
        // Empty document_ids means unrestricted retrieval in RAGFlow: never send it.
        if(!candidates.length)return send(res,200,{hits:[],total:0,note:'所选范围内暂无已解析且可检索的资料。'});
        const allowed=new Map(candidates.map(r=>[r.document_id,r]));const limit=Math.min(20,Math.max(1,Number(body.limit)||6));
        const result=await rag.retrieve(question.trim(),[...new Set(candidates.map(r=>r.dataset_id))],[...allowed.keys()],limit);
        const hits=chunksOf(result).filter(c=>allowed.has(c.document_id||c.doc_id)).map(c=>hitOf(c,allowed.get(c.document_id||c.doc_id))).filter(h=>h.text);
        return send(res,200,{hits,total:hits.length});
      }
      if(['GET','HEAD'].includes(req.method)&&staticFiles.has(url.pathname)){
        const name=staticFiles.get(url.pathname),buffer=await fsp.readFile(path.join(staticDir,name));
        res.writeHead(200,{'Content-Type':mime[path.extname(name)]||'application/octet-stream','Content-Length':buffer.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});return res.end(req.method==='HEAD'?undefined:buffer);
      }
      throw new AppError(404,'接口或文件不存在。');
    }catch(err){if(!res.headersSent&&!res.destroyed)send(res,err.status||500,{error:err instanceof AppError?err.message:'本地服务处理失败，请检查资料目录和服务日志。'});}
  });
  server.requestTimeout=10*60*1000;server.headersTimeout=60000;
  const timer=setInterval(()=>processQueue().catch(()=>{}),workerInterval);timer.unref();
  return {server,store,status,processQueue,async close(){closed=true;clearInterval(timer);if(server.listening)await new Promise(resolve=>server.close(resolve));while(processing)await new Promise(r=>setTimeout(r,20));store.close();}};
}
if(require.main===module){
  const port=Number(process.argv[2]||8765);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口需在1024到65535之间。');
  const app=createApp();app.server.listen(port,'127.0.0.1',()=>console.log(`MathModel AI\nhttp://127.0.0.1:${port}\n知识库原件与索引配置保存在本项目 .data 目录；其他模块继续使用浏览器存储。`));
  app.server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'端口已被占用，请选择另一个端口。':'本地服务启动失败。');process.exitCode=1;});
}
module.exports={createApp,readConfig,localURL};
