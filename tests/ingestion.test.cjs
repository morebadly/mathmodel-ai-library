'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createLibraryApp}=require('../server-library.cjs'),{classify,associations}=require('../backend/classify.cjs');
const {CATEGORIES}=require('../backend/domain.cjs');
const {docx,pptx,xlsx,pdf,zip}=require('./document-fixtures.cjs');
async function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mm-auto-ingestion-'));const app=createLibraryApp({dataDir:dir,...options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});return {...app,dir,url:'http://127.0.0.1:'+app.server.address().port};}
async function upload(app,name,bytes,category){const query=new URLSearchParams({name,...(category?{category}:{})});const response=await fetch(app.url+'/api/library/resources?'+query,{method:'POST',body:bytes});assert.equal(response.status,201);return (await response.json()).item;}
async function done(app,id){const deadline=Date.now()+30000;while(Date.now()<deadline){const response=await fetch(app.url+'/api/library/resources/'+id),item=(await response.json()).item;if(!['queued','parsing'].includes(item.ingestion.status))return item;await new Promise(r=>setTimeout(r,40));}throw new Error('解析结果超时：'+id);}

test('六类自动归类遵循资料用途；不明内容标记待确认；赛事关联需明确赛事',()=>{for(const [name,text,want] of [['线性规划方法知识卡.docx','理论知识',0],['2024年国赛A题.pdf','问题要求',1],['优秀论文-交通模型.pdf','摘要',2],['solve.py','print(1)',3],['论文格式与评分标准.docx','',4],['线性规划培训课件.pptx','线性规划',5]])assert.equal(classify(name,text).category,CATEGORIES[want]);assert.equal(classify('未命名.txt','没有用途线索').review,true);assert.deepEqual(associations('2024-A-01.pdf','').problems,[]);assert.deepEqual(associations('2024年国赛A题.pdf','').problems,['CUMCM:2024:A']);});
test('上传后自动解析 DOCX/PPTX/XLSX/PDF，正文可搜索且原件完整',async t=>{const app=await fixture(t);const samples=[['线性规划方法卡.docx',docx('线性规划 验收词星河明珠'), '星河明珠','docx'],['教学课件.pptx',pptx('训练课件 验收词青山绿水'),'青山绿水','pptx'],['训练表格.xlsx',xlsx('验收词繁星之海'),'繁星之海','xlsx'],['2026 MCM Problem A.pdf',pdf('2026 MCM Problem A - UploadPDFUniqueToken'),'UploadPDFUniqueToken','pdf']];const uploaded=[];for(const [name,bytes,term,format] of samples){uploaded.push([await upload(app,name,bytes),bytes,term,format]);}assert.equal((await fetch(app.url+'/health')).status,200);for(const [row,bytes,term,format] of uploaded){const item=await done(app,row.id);assert.ok(['ready','partial'].includes(item.ingestion.status),JSON.stringify(item.ingestion));assert.equal(item.ingestion.format,format);assert.ok(item.text.includes(term));const search=await(await fetch(app.url+'/api/library/resources?'+new URLSearchParams({q:term}))).json();assert.ok(search.items.some(x=>x.id===item.id));const file=await fetch(app.url+'/api/library/assets/'+item.assets[0].id);assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);}});
test('手动分类优先且重命名后仍可按原件格式重试；重复上传不增加记录',async t=>{const app=await fixture(t),bytes=docx('线性规划与主成分分析');const item=await upload(app,'课程讲义.docx',bytes);await fetch(app.url+'/api/library/resources/'+item.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:CATEGORIES[0],title:'我的阅读笔记'})});const parsed=await done(app,item.id);assert.equal(parsed.category,CATEGORIES[0]);assert.equal(parsed.ingestion.categoryMode,'manual');assert.equal(parsed.ingestion.needsReview,false);const retry=await fetch(app.url+'/api/library/resources/'+item.id+'/reparse',{method:'POST'});assert.equal(retry.status,202);const again=await done(app,item.id);assert.equal(again.ingestion.format,'docx');assert.ok(again.text.includes('线性规划'));const count=app.store.stats().total;const duplicate=await upload(app,'课程讲义.docx',bytes);assert.equal(duplicate.id,item.id);assert.equal(app.store.stats().total,count);});
test('扫描 PDF、不支持格式、损坏文件和 ZIP 如实标明；ZIP 不展开',async t=>{const app=await fixture(t);const scan=await done(app,(await upload(app,'扫描件.pdf',pdf())).id);assert.equal(scan.ingestion.status,'needs_ocr',JSON.stringify(scan.ingestion));const broken=await done(app,(await upload(app,'损坏文件.pdf',Buffer.from('%PDF-broken'))).id);assert.equal(broken.ingestion.status,'error');assert.equal(broken.assets.length,1);const archive=await done(app,(await upload(app,'资料包.zip',zip({'inside.txt':'压缩包内部唯一词银杏大道'}))).id);assert.equal(archive.ingestion.status,'saved_only');assert.match(archive.ingestion.message,/不自动展开/);assert.equal(archive.text,'');assert.equal((await(await fetch(app.url+'/api/library/resources?'+new URLSearchParams({q:'银杏大道'}))).json()).total,0);});
test('本地解析不请求外部图像或 OCR；失败任务可重试且原件不丢失',async t=>{const app=await fixture(t);const body='# 线性规划\n\n本地解析验收墨雨云间\n\n![remote](https://example.com/should-not-fetch.png)';const item=await done(app,(await upload(app,'理论方法卡.md',body)).id);assert.equal(item.ingestion.status,'ready',JSON.stringify(item.ingestion));assert.ok(item.text.includes('墨雨云间'));assert.ok(!item.bodyHTML.includes('<img'));const timeout=await fixture(t,{ingestionOptions:{timeoutMs:1}});const row=await done(timeout,(await upload(timeout,'文档.docx',docx('超时保留原件测试'))).id);assert.equal(row.ingestion.status,'error');assert.equal(row.assets.length,1);});

test('连续失败重解析保留现有正文、检索、分类、字数和关联；旧资料也受保护',async t=>{
  const app=await fixture(t),before=await done(app,(await upload(app,'2024年国赛A题.docx',docx('线性规划 验收词古道秋风'))).id);
  app.ingestion.timeoutMs=1;
  for(let n=0;n<2;n++){
    assert.equal((await fetch(app.url+'/api/library/resources/'+before.id+'/reparse',{method:'POST'})).status,202);
    const after=await done(app,before.id);assert.equal(after.ingestion.status,'error');
    for(const key of ['bodyHTML','text','category','kind','availability','summary','contest','year','problem'])assert.equal(after[key],before[key],key);
    assert.deepEqual(after.problemKeys,before.problemKeys);assert.equal(after.ingestion.charCount,before.ingestion.charCount);assert.equal(after.ingestion.format,'docx');
    assert.match(after.ingestion.message,/保留现有正文/);
    assert.equal((await(await fetch(app.url+'/api/library/resources?'+new URLSearchParams({q:'古道秋风'}))).json()).total,1);
  }
  const now=new Date().toISOString();app.store.insertResource({id:'kb_curated',source_key:'curated:1',title:'已有知识卡',category:CATEGORIES[0],kind:'知识卡',availability:'本地正文',body_text:'原有正文不能丢失',body_html:'<p>原有正文不能丢失</p>',created_at:now,updated_at:now});
  app.ingestion.enqueue('kb_curated');app.ingestion.finish('kb_curated',{status:'error',text:'',html:'',format:'',message:'测试失败。'});
  const curated=app.store.get('kb_curated');assert.equal(curated.text,'原有正文不能丢失');assert.equal(curated.ingestion.charCount,curated.text.length);assert.equal(curated.category,CATEGORIES[0]);
});

test('同一文件并发上传只生成一条记录，手动分类始终优先',async t=>{
  const app=await fixture(t),bytes=docx('线性规划并发上传验证');
  const items=await Promise.all([upload(app,'课程讲义.docx',bytes),upload(app,'课程讲义.docx',bytes,CATEGORIES[4]),upload(app,'另一名称.docx',bytes)]);
  assert.equal(new Set(items.map(x=>x.id)).size,1);assert.equal(app.store.stats().total,1);
  const item=await done(app,items[0].id);assert.equal(item.category,CATEGORIES[4]);assert.equal(item.ingestion.categoryMode,'manual');assert.equal(item.ingestion.needsReview,false);
  await fetch(app.url+'/api/library/resources/'+item.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:CATEGORIES[3]})});
  const changed=app.store.get(item.id);assert.equal(changed.kind,'代码');assert.equal(changed.category,CATEGORIES[3]);
  await upload(app,'重新指定的论文.docx',bytes,CATEGORIES[2]);assert.equal(app.store.get(item.id).kind,'论文');
});

test('PDF 丢页或文字编码警告显示部分解析',async t=>{
  const {parseDocument}=require('../backend/parse-document.cjs'),Module=require('node:module'),original=Module._load;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mm-auto-ingestion-')),file=path.join(dir,'fixture.pdf');fs.writeFileSync(file,pdf('Visible text'));
  t.after(()=>{Module._load=original;fs.rmSync(dir,{recursive:true,force:true});});
  for(const code of ['PAGE_LOAD_FAILED','PDF_TEXT_ENCODING_SUSPECT']){
    Module._load=function(id,...args){if(id==='officeparser')return {parseOffice:async()=>({type:'pdf',warnings:[{code}],to:async type=>({value:type==='text'?'Some visible text':'<p>Some visible text</p>'})})};return original.call(this,id,...args);};
    const item=await parseDocument(file,'fixture.pdf');assert.equal(item.status,'partial',code);assert.match(item.message,/页面缺失或文字编码异常/);
  }
  Module._load=original;
});

test('服务重启后继续未完成队列，原件与正文保持可用',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mm-auto-ingestion-'));let current=createLibraryApp({dataDir:dir});
  t.after(async()=>{await current.close();fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise(r=>current.server.listen(0,'127.0.0.1',r));current.url='http://127.0.0.1:'+current.server.address().port;
  current.ingestion.closed=true;
  const first=await upload(current,'教学课件.pptx',pptx('重启后恢复队列星沉海底')),second=await upload(current,'训练表格.xlsx',xlsx('恢复队列峰回路转'));
  current.store.db.prepare("UPDATE library_ingestion SET status='parsing' WHERE resource_id=?").run(first.id);
  await current.close();current=createLibraryApp({dataDir:dir});await new Promise(r=>current.server.listen(0,'127.0.0.1',r));current.url='http://127.0.0.1:'+current.server.address().port;
  for(const item of [first,second]){const parsed=await done(current,item.id);assert.equal(parsed.ingestion.status,'ready');assert.equal(parsed.assets.length,1);assert.ok(parsed.text.includes('队列'));}
  assert.equal(current.store.stats().total,2);
});
