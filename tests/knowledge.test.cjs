'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const vm=require('node:vm');
const {createApp}=require('../server-ragflow.cjs');
const {CATEGORIES}=require('../backend/domain.cjs');
const {extractHTML}=require('../backend/html-text.cjs');

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
async function setup(t){
  const datasets=[],docs=[];let uploads=0,retrievals=0,failParse=false,lastRetrieval;
  const fake=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');let raw='';for await(const chunk of req)raw+=chunk.toString();
    const json=raw.startsWith('{')?JSON.parse(raw):null;
    const reply=(data,code=0)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code,data,...(code?{message:'test upstream failure'}:{})}));};
    assert.equal(req.headers.authorization,'Bearer fixture-test-key');
    if(url.pathname==='/api/v1/datasets'){
      if(req.method==='POST'){const item={...json,id:'ds'+datasets.length};datasets.push(item);return reply(item);}
      return reply(datasets.filter(d=>!url.searchParams.get('name')||d.name===url.searchParams.get('name')));
    }
    const m=url.pathname.match(/^\/api\/v1\/datasets\/([^/]+)\/(documents|chunks)(?:\/([^/]+)\/chunks)?$/);
    if(m){
      if(m[2]==='documents'&&req.method==='POST'){
        uploads++;const name=raw.match(/filename="([^"]+)"/)?.[1]||'file';const d={id:'doc'+docs.length,dataset_id:m[1],name,run:'UNSTART',chunk_count:0};docs.push(d);return reply([d]);
      }
      if(m[2]==='chunks'&&req.method==='POST'){
        if(failParse){failParse=false;return reply(null,102);}
        for(const d of docs.filter(d=>json.document_ids.includes(d.id))){d.run='DONE';d.progress=1;d.chunk_count=2;}return reply();
      }
      if(m[3])return reply({chunks:[{id:'chunk1',document_id:m[3],content:'实际命中的段落，位于文档后半部分。'}],total:1});
      return reply({docs:docs.filter(d=>d.dataset_id===m[1]&&(!url.searchParams.get('id')||d.id===url.searchParams.get('id'))&&(!url.searchParams.get('keywords')||d.name.includes(url.searchParams.get('keywords'))))});
    }
    if(url.pathname==='/api/v1/retrieval'){
      retrievals++;lastRetrieval=json;
      return reply({chunks:[...json.document_ids.map(id=>({id:'hit-'+id,document_id:id,content:'实际命中的段落，位于文档后半部分。',similarity:0.8,page_num:7})),{id:'forged',document_id:'not-allowed',content:'不得出现在结果中的其他文档'}]});
    }
    res.statusCode=404;reply(null,404);
  });
  const upstream=await listen(fake);const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mathmodel-knowledge-test-'));
  await fs.writeFile(path.join(dir,'ragflow.json'),JSON.stringify({baseURL:upstream,apiKey:'fixture-test-key',embeddingModel:'fixture@Ollama'}));
  let app=createApp({dataDir:dir,workerInterval:60000});let base=await listen(app.server);
  const request=async(route,opts)=>{const res=await fetch(base+route,opts);return {status:res.status,body:await res.json()};};
  const upload=async(name,cat=CATEGORIES[0],scope='公开资料',body='原始资料正文')=>request('/api/knowledge/resources?'+new URLSearchParams({name,category:cat,scope}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body});
  const json=(body,method='POST')=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const ready=async id=>{for(let i=0;i<80;i++){await app.processQueue();if(app.store.get(id)?.status==='ready')return;await new Promise(r=>setTimeout(r,10));}assert.fail('资料未完成解析');};
  t.after(async()=>{await app.close();await new Promise(r=>fake.close(r));/* Temp fixtures are left to the OS temp lifecycle. */});
  return {request,upload,ready,json,get app(){return app;},get base(){return base;},get uploads(){return uploads;},get retrievals(){return retrievals;},get lastRetrieval(){return lastRetrieval;},failNextParse(){failParse=true;},async restart(){await app.close();app=createApp({dataDir:dir,workerInterval:60000});base=await listen(app.server);}};
}

test('原件落盘、重复导入、真实HTTP解析流程、状态刷新与重启恢复',async t=>{
  const f=await setup(t);
  const first=await f.upload('方法.txt');assert.equal(first.status,201);const id=first.body.resource.id;
  await f.ready(id);assert.equal(f.app.store.get(id).status,'ready');assert.equal(f.uploads,1);
  const copies=await Promise.all([f.upload('同文副本.txt'),f.upload('同文副本2.txt')]);
  assert(copies.every(x=>x.body.duplicate));assert.equal(f.app.store.list().length,1);
  assert.equal(await(await fetch(f.base+'/api/knowledge/resources/'+id+'/file')).text(),'原始资料正文');
  await f.restart();assert.equal(f.app.store.get(id).status,'ready');
  assert.equal(await(await fetch(f.base+'/api/knowledge/resources/'+id+'/file')).text(),'原始资料正文');
});

test('分类、分区和原文引用过滤；空集合不会触发无范围RAGFlow检索',async t=>{
  const f=await setup(t);const a=(await f.upload('公开资料.txt')).body.resource;
  const b=(await f.upload('教师资料.txt',CATEGORIES[1],'教师私有','私有正文')).body.resource;
  await f.ready(a.id);await f.ready(b.id);
  const found=await f.request('/api/knowledge/retrieve',f.json({question:'后半部分',category:CATEGORIES[0]}));
  assert.equal(found.status,200);assert.equal(found.body.hits.length,1);
  assert.equal(found.body.hits[0].resource.id,a.id);assert.equal(found.body.hits[0].page,7);assert.match(found.body.hits[0].text,/后半部分/);
  assert.equal(f.lastRetrieval.document_ids.length,1);assert.equal(found.body.hits.some(h=>h.chunkId==='forged'),false);
  const calls=f.retrievals;
  const empty=await f.request('/api/knowledge/retrieve',f.json({question:'私有',scope:'教师私有'}));
  assert.equal(empty.body.hits.length,0);assert.equal(f.retrievals,calls);
});

test('解析失败后重试复用文档ID；分类修改重新建索引',async t=>{
  const f=await setup(t);f.failNextParse();const a=(await f.upload('重试.txt')).body.resource;
  for(let i=0;i<80&&f.app.store.get(a.id).status!=='error';i++){await f.app.processQueue();await new Promise(r=>setTimeout(r,10));}
  assert.equal(f.app.store.get(a.id).status,'error');assert.equal(f.uploads,1);
  await f.request('/api/knowledge/resources/'+a.id+'/retry',f.json({}));await f.ready(a.id);assert.equal(f.uploads,1);
  await f.request('/api/knowledge/resources/'+a.id,f.json({category:CATEGORIES[3]},'PATCH'));
  await f.ready(a.id);assert.equal(f.app.store.get(a.id).category,CATEGORIES[3]);assert.equal(f.uploads,2);
});

test('阻止非法分类、跨网站写入、私有配置读取和空文件；ZIP不伪装解析成功',async t=>{
  const f=await setup(t);
  assert.equal((await f.upload('bad.txt','自创第七类')).status,400);
  assert.equal((await f.upload('../escape.txt')).status,400);
  assert.equal((await f.upload('空.txt',CATEGORIES[0],'公开资料','')).status,400);
  assert.equal((await f.request('/api/knowledge/config',{'method':'PUT',headers:{'Content-Type':'application/json',Origin:'https://example.invalid'},body:'{}'})).status,403);
  assert.equal((await f.request('/.data/ragflow.json')).status,404);
  const status=await f.request('/api/knowledge/status');assert.equal(status.status,200);assert.equal(JSON.stringify(status).includes('fixture-test-key'),false);
  const zip=await f.upload('赛题包.zip',CATEGORIES[1]);assert.equal(zip.body.resource.status,'needs_unpack');
});

test('HTML内嵌JSON卡片被抽取，脚本不执行，样式不进入正文',()=>{
  const cards=[{t:'线性规划',body:'<p>资源最优分配：max c^T x</p>',g:'规划',u:'https://example.invalid'}];
  const output=extractHTML('<style>.evil{display:none}</style><h1>知识卡</h1><script>globalThis.shouldNeverRun=true; var DATA = '+JSON.stringify(cards)+';</script>');
  assert.match(output,/线性规划/);assert.match(output,/max c\^T x/);assert.equal(output.includes('shouldNeverRun'),false);assert.equal(output.includes('.evil'),false);assert.equal(globalThis.shouldNeverRun,undefined);
});

test('原六类前后端一致，旧教师分类迁移为教学与训练和教师私有分区',async()=>{
  const sandbox={window:{},console,Date,URL,Blob,structuredClone};vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(path.join(__dirname,'..','core.js'),'utf8'),sandbox);
  const M=sandbox.window.MM;assert.deepEqual(Array.from(M.categories),CATEGORIES);
  const value={format:'mathmodel-ai-backup',version:1,state:M.blank(),files:[]};
  const id='old-file-0001',createdAt=new Date().toISOString();
  value.state.resources.push({id,name:'教师资料.txt',size:1,type:'text/plain',kind:'knowledge',category:'教师专属知识库',scope:'公开资料',text:'a',description:'',tags:'',createdAt});
  value.files.push({id,type:'text/plain',data:'YQ=='});
  M.validateBackup(value);assert.equal(value.state.resources[0].category,'教学与训练');assert.equal(value.state.resources[0].scope,'教师私有');
});
