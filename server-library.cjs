'use strict';
const http=require('node:http'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');const {Transform}=require('node:stream');
const {LibraryStore}=require('./backend/library-store.cjs');
const {CATEGORIES,AppError}=require('./backend/domain.cjs');
const {classify,kindFor}=require('./backend/classify.cjs');
const {IngestionQueue}=require('./backend/ingestion.cjs');
const {loadLimits,uploadLimit}=require('./backend/limits.cjs');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.bcmap':'application/octet-stream','.wasm':'application/wasm','.icc':'application/octet-stream','.pfb':'application/octet-stream'};
function json(res,status,body){const data=Buffer.from(JSON.stringify(body));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);}
function rangeOf(header,size){
  if(!header)return null;const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||!m[1]&&!m[2])return false;
  let start,end;if(!m[1]){const suffix=Number(m[2]);if(!suffix)return false;start=Math.max(0,size-suffix);end=size-1;}else{start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),size-1):size-1;}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return false;return {start,end};
}
async function bodyJSON(req){let bytes=0;const parts=[];for await(const x of req){bytes+=x.length;if(bytes>1024*1024)throw new AppError(413,'信息过长。');parts.push(x);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new AppError(400,'请求格式无效。');}}
function createLibraryApp({dataDir=path.join(__dirname,'.data'),staticDir=__dirname,ingestionOptions={},limits=loadLimits()}={}){
  const store=new LibraryStore(dataDir);
  const ingestion=new IngestionQueue(store,{...ingestionOptions,maxParseBytes:limits.maxParseBytes});
  const staticFiles=new Set(['index.html','core.js','knowledge.js','library-view.js','library-reader.js','app.js','styles.css','library.css','pdf-viewer.html','pdf-viewer.js','pdf-viewer.css','assets/favicon.svg']);
  async function upload(req,url){
    const name=url.searchParams.get('name'),requested=url.searchParams.get('category'),automatic=!requested||requested==='auto';
    if(!name||name.length>240||/[\x00-\x1f/\\]/.test(name))throw new AppError(400,'文件名无效。');if(!automatic&&!CATEGORIES.includes(requested))throw new AppError(400,'请选择自动识别或原六类中的一个分类。');
    const category=automatic?classify(name).category:requested;
    const ext=path.extname(name).toLowerCase(),max=uploadLimit(limits,name);
    const declared=Number(req.headers['content-length']);if(max&&declared>max)throw new AppError(413,'文件超过当前服务配置的上传大小上限。');
    const tmp=path.join(store.dir,'tmp',crypto.randomUUID()+'.part'),hash=crypto.createHash('sha256');let size=0;
    try{
      await pipeline(req,new Transform({transform(chunk,enc,cb){size+=chunk.length;if(max&&size>max)return cb(new AppError(413,'文件超过当前服务配置的上传大小上限。'));hash.update(chunk);cb(null,chunk);}}),fs.createWriteStream(tmp,{flags:'wx'}));
      if(!size)throw new AppError(400,'文件为空。');const sha=hash.digest('hex');
      const sourceKey='upload:'+sha;
      const id='kb_'+crypto.createHash('sha256').update(sourceKey).digest('hex').slice(0,32),assetId='asset_'+sha;
      const rel='files/'+sha,destination=path.join(store.dir,rel);await fsp.copyFile(tmp,destination,fs.constants.COPYFILE_EXCL).catch(e=>{if(e.code!=='EEXIST')throw e;});
      const isPDF=ext==='.pdf',kind=kindFor(category,name,isPDF?'pdf':'');
      const now=new Date().toISOString();
      store.db.exec('BEGIN IMMEDIATE');
      try{
        // Check after the asynchronous file copy, inside the same transaction as insertion.
        // Concurrent duplicate uploads must preserve an explicit manual category.
        const duplicate=store.db.prepare("SELECT r.id FROM library_resources r JOIN library_resource_assets ra ON ra.resource_id=r.id JOIN library_assets a ON a.id=ra.asset_id WHERE r.source_key LIKE 'upload:%' AND a.sha256=? ORDER BY r.created_at LIMIT 1").get(sha);
        if(duplicate){
          if(!automatic){const old=store.get(duplicate.id);store.db.prepare('UPDATE library_resources SET category=?,kind=?,updated_at=? WHERE id=?').run(category,kindFor(category,old.title,old.ingestion?.format||''),now,duplicate.id);store.db.prepare("UPDATE library_ingestion SET category_mode='manual',needs_review=0,confidence='manual',reason='按手动指定分类保存。' WHERE resource_id=?").run(duplicate.id);}
          if(!store.get(duplicate.id).ingestion)ingestion.enqueue(duplicate.id,{mode:automatic?'auto':'manual'});
          store.db.exec('COMMIT');return {item:store.get(duplicate.id),duplicate:true};
        }
        store.insertResource({id,source_key:sourceKey,title:name,category,kind,availability:isPDF?'PDF原件':'附件包',summary:'原件已保存，等待自动解析正文。',body_html:'',body_text:'',tags_json:'[]',source_label:'成员导入',note:'',created_at:now,updated_at:now});
        store.db.prepare('INSERT OR IGNORE INTO library_assets(id,sha256,path,size,mime,original_name) VALUES(?,?,?,?,?,?)').run(assetId,sha,rel,size,isPDF?'application/pdf':ext==='.txt'?'text/plain; charset=utf-8':'application/octet-stream',name);
        store.db.prepare('INSERT OR IGNORE INTO library_resource_assets(resource_id,asset_id,label,role) VALUES(?,?,?,?)').run(id,assetId,name,'primary');
        ingestion.enqueue(id,{mode:automatic?'auto':'manual'});store.db.exec('COMMIT');
      }catch(e){store.db.exec('ROLLBACK');throw e;}
      return {item:store.get(id),duplicate:false};
    }finally{await fsp.unlink(tmp).catch(()=>{});}
  }
  const server=http.createServer(async(req,res)=>{
    try{
      const host=String(req.headers.host||'');if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host))throw new AppError(403,'此版本在本机运行。');
      if(!['GET','HEAD'].includes(req.method)&&req.headers.origin&&!['http://'+host,'http://localhost:'+server.address().port,'http://127.0.0.1:'+server.address().port].includes(req.headers.origin))throw new AppError(403,'拒绝跨网站写入。');
      const url=new URL(req.url,'http://'+host);let match;
      if(url.pathname==='/health'&&req.method==='GET')return json(res,200,{app:'MathModel AI',version:'1.3.1',mode:'library-reading',automaticIngestion:true,fileSizeLimits:limits,ragflowEnabled:false,agentEnabled:false});
      if(url.pathname==='/api/library/stats'&&req.method==='GET')return json(res,200,store.stats());
      if(url.pathname==='/api/library/ingestion'&&req.method==='GET')return json(res,200,store.ingestionList());
      if(url.pathname==='/api/library/resources'&&req.method==='GET')return json(res,200,store.list(Object.fromEntries(url.searchParams)));
      if(url.pathname==='/api/library/resources'&&req.method==='POST')return json(res,201,await upload(req,url));
      if((match=url.pathname.match(/^\/api\/library\/resources\/(kb_[a-zA-Z0-9_-]+)$/))){
        if(req.method==='GET'){const item=store.get(match[1]);if(!item)throw new AppError(404,'资料不存在。');return json(res,200,{item});}
        if(req.method==='PATCH'){
          const input=await bodyJSON(req),old=store.get(match[1]);if(!old)throw new AppError(404,'资料不存在。');
          if(input.category&&!CATEGORIES.includes(input.category))throw new AppError(400,'分类无效。');
          const title=input.title??old.title,note=input.note??old.note,tags=input.tags??old.tags;
          if(typeof title!=='string'||!title.trim()||title.length>240||typeof note!=='string'||note.length>12000||!Array.isArray(tags)||tags.some(x=>typeof x!=='string'||x.length>80)||tags.length>40)throw new AppError(400,'资料信息格式无效。');
          store.db.prepare('UPDATE library_resources SET title=?,category=?,kind=?,note=?,tags_json=?,updated_at=? WHERE id=?').run(title.trim(),input.category||old.category,input.category?kindFor(input.category,title,old.ingestion?.format||(old.pdf?'pdf':'')):old.kind,note,JSON.stringify(tags),new Date().toISOString(),old.id);
          if(input.category)store.db.prepare("UPDATE library_ingestion SET category_mode='manual',needs_review=0,confidence='manual',reason='已由使用者确认分类。' WHERE resource_id=?").run(old.id);
          return json(res,200,{item:store.get(old.id)});
        }
      }
      if((match=url.pathname.match(/^\/api\/library\/resources\/(kb_[a-zA-Z0-9_-]+)\/reparse$/))&&req.method==='POST'){
        const item=store.get(match[1]);if(!item)throw new AppError(404,'资料不存在。');
        if(!item.assets.some(a=>a.role==='primary'))throw new AppError(400,'这条索引没有可解析的本地原件。');
        if(['queued','parsing'].includes(item.ingestion?.status))throw new AppError(409,'这份资料已在解析队列中。');
        ingestion.enqueue(item.id,{mode:item.ingestion?.categoryMode||'manual'});return json(res,202,{item:store.get(item.id)});
      }
      if((match=url.pathname.match(/^\/api\/library\/assets\/(asset_[a-zA-Z0-9_-]+)$/))&&['GET','HEAD'].includes(req.method)){
        const asset=store.asset(match[1]);if(!asset)throw new AppError(404,'附件不存在。');
        const range=rangeOf(req.headers.range,asset.size);if(range===false){res.writeHead(416,{'Content-Range':'bytes */'+asset.size});return res.end();}
        const inline=url.searchParams.get('inline')==='1'&&asset.mime==='application/pdf';
        const headers={'Content-Type':asset.mime,'Content-Length':range?range.end-range.start+1:asset.size,'Accept-Ranges':'bytes','Content-Disposition':(inline?'inline':'attachment')+"; filename*=UTF-8''"+encodeURIComponent(asset.original_name),'X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=3600'};
        if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${asset.size}`;
        res.writeHead(range?206:200,headers);if(req.method==='HEAD')return res.end();return fs.createReadStream(asset.file,range||{}).on('error',()=>res.destroy()).pipe(res);
      }
      if(['GET','HEAD'].includes(req.method)){
        let relative=url.pathname==='/'?'index.html':url.pathname.slice(1),file;
        if(relative.startsWith('vendor/')){
          try{relative=decodeURIComponent(relative);}catch{throw new AppError(400,'文件路径无效。');}
          const base=path.join(staticDir,'vendor');file=path.resolve(staticDir,relative);if(!file.startsWith(base+path.sep)||!types[path.extname(file)])throw new AppError(404,'文件不存在。');
        }else if(staticFiles.has(relative))file=path.join(staticDir,relative);
        if(file){let stat;try{stat=await fsp.stat(file);}catch{throw new AppError(404,'文件不存在。');}if(!stat.isFile())throw new AppError(404,'文件不存在。');res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD')return res.end();return fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);}
      }
      throw new AppError(404,'接口或文件不存在。');
    }catch(e){if(!res.headersSent&&!res.destroyed)json(res,e.status||500,{error:e instanceof AppError?e.message:'本地资料服务处理失败。'});}
  });
  // Stream originals to disk without a fixed total upload duration.
  server.requestTimeout=0;
  return {server,store,ingestion,async close(){await ingestion.close();if(server.listening)await new Promise(r=>server.close(r));store.close();}};
}
module.exports={createLibraryApp,rangeOf};
