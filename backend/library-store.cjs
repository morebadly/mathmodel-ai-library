'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {CATEGORIES,AppError}=require('./domain.cjs');
const sanitize=require('sanitize-html');
const ALLOWED_TAGS=[...sanitize.defaults.allowedTags,'details','summary','pre','code','sub','sup','img','h1','h2','h3','h4','h5','h6'];
function safeHTML(value){
  return sanitize(value||'',{allowedTags:ALLOWED_TAGS,allowedAttributes:{'*':['class'],'a':['href','title','target','rel'],'img':['src','alt','width','height'],'code':['class'],'pre':['data-language'],'td':['colspan','rowspan'],'th':['colspan','rowspan']},allowedSchemes:['https','http','mailto'],allowedSchemesByTag:{img:['data']},allowProtocolRelative:false,
    exclusiveFilter:frame=>['button','input','select','textarea','form','iframe'].includes(frame.tag)||(frame.tag==='img'&&!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(frame.attribs.src||'')),
    transformTags:{a:(tag,attrs)=>({tagName:'a',attribs:{href:attrs.href||'',title:attrs.title||'',target:'_blank',rel:'noopener noreferrer'}})}
  });
}
const parseList=value=>{try{return JSON.parse(value||'[]');}catch{return [];}};
const ING_COLS="i.status ing_status,i.format ing_format,i.char_count ing_chars,i.message ing_message,i.category_mode ing_mode,i.confidence ing_confidence,i.needs_review ing_review,i.reason ing_reason";
const ingestion=row=>row.ing_status?{status:row.ing_status,format:row.ing_format,charCount:row.ing_chars,message:row.ing_message,categoryMode:row.ing_mode,confidence:row.ing_confidence,needsReview:!!row.ing_review,reason:row.ing_reason}:null;
function card(row){return {id:row.id,title:row.title,name:row.title,category:row.category,kind:row.kind,availability:row.availability,summary:row.summary,contest:row.contest,year:row.year,problem:row.problem,method:row.method,tags:parseList(row.tags_json),sourceLabel:row.source_label,sourceURL:row.source_url,note:row.note,createdAt:row.created_at,pdf:!!row.pdf,assetCount:row.asset_count||0,ingestion:ingestion(row)};}
class LibraryStore{
  constructor(dir){this.dir=path.resolve(dir);fs.mkdirSync(path.join(dir,'files'),{recursive:true});fs.mkdirSync(path.join(dir,'tmp'),{recursive:true});this.db=new DatabaseSync(path.join(dir,'library.sqlite'));this.db.exec(fs.readFileSync(path.join(__dirname,'library-schema.sql'),'utf8'));this.db.exec('PRAGMA busy_timeout=5000');}
  stats(){
    const categories=CATEGORIES.map(name=>({name,count:this.db.prepare('SELECT count(*) n FROM library_resources WHERE category=?').get(name).n}));
    const kinds=this.db.prepare('SELECT kind name,count(*) count FROM library_resources GROUP BY kind ORDER BY count DESC').all();
    const years=this.db.prepare('SELECT DISTINCT year FROM library_resources WHERE year IS NOT NULL ORDER BY year DESC').all().map(r=>r.year);
    const contests=this.db.prepare("SELECT DISTINCT contest FROM library_resources WHERE contest<>'' ORDER BY contest").all().map(r=>r.contest);
    return {categories,kinds,years,contests,total:categories.reduce((s,c)=>s+c.count,0),pdfCount:this.db.prepare("SELECT count(*) n FROM library_assets WHERE mime='application/pdf'").get().n,cardCount:this.db.prepare("SELECT count(*) n FROM library_resources r WHERE availability='本地正文' OR EXISTS(SELECT 1 FROM library_ingestion i WHERE i.resource_id=r.id AND i.char_count>0)").get().n,problemCount:this.db.prepare('SELECT count(DISTINCT problem_key) n FROM library_problems').get().n,mode:'reading',ragflowEnabled:false};
  }
  list(filters={}){
    const where=[],params=[];let q=String(filters.q||'').trim();if(q.length>160)q=q.slice(0,160);
    if(filters.category){if(!CATEGORIES.includes(filters.category))throw new AppError(400,'分类无效。');where.push('r.category=?');params.push(filters.category);}
    if(filters.kind){where.push('r.kind=?');params.push(String(filters.kind).slice(0,80));}
    if(filters.contest){where.push('r.contest=?');params.push(String(filters.contest).slice(0,80));}
    if(filters.year){const year=Number(filters.year);if(!Number.isInteger(year))throw new AppError(400,'年份无效。');where.push('r.year=?');params.push(year);}
    if(filters.availability){where.push('r.availability=?');params.push(String(filters.availability).slice(0,80));}
    if(filters.problemKey){where.push('EXISTS(SELECT 1 FROM library_problems p WHERE p.resource_id=r.id AND p.problem_key=?)');params.push(String(filters.problemKey).slice(0,80));}
    for(const term of q.toLowerCase().split(/\s+/).filter(Boolean).slice(0,8)){
      where.push("lower(r.title||' '||r.body_text||' '||r.tags_json||' '||r.source_label||' '||coalesce(r.year,'')||' '||r.problem||' '||r.method) LIKE ? ESCAPE '\\'");params.push('%'+term.replace(/[\\%_]/g,'\\$&')+'%');
    }
    const clause=where.length?' WHERE '+where.join(' AND '):'';
    const total=this.db.prepare('SELECT count(*) n FROM library_resources r'+clause).get(...params).n;
    const pageSize=Math.min(48,Math.max(1,parseInt(filters.pageSize)||18));const pages=Math.max(1,Math.ceil(total/pageSize));const page=Math.min(pages,Math.max(1,parseInt(filters.page)||1));
    const relevance=q?"CASE WHEN lower(r.title)=? THEN 0 WHEN lower(r.title) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, ":'';
    const rankParams=q?[q.toLowerCase(),'%'+q.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%']:[];
    const rows=this.db.prepare(`SELECT r.*,${ING_COLS}, (SELECT count(*) FROM library_resource_assets a WHERE a.resource_id=r.id) asset_count,
      EXISTS(SELECT 1 FROM library_resource_assets a JOIN library_assets f ON f.id=a.asset_id WHERE a.resource_id=r.id AND f.mime='application/pdf' AND a.role='primary') pdf
      FROM library_resources r LEFT JOIN library_ingestion i ON i.resource_id=r.id${clause} ORDER BY ${relevance}CASE WHEN r.source_key LIKE 'upload:%' THEN 0 ELSE 1 END,CASE WHEN r.source_key LIKE 'upload:%' THEN r.created_at ELSE '' END DESC,CASE WHEN r.availability='本地正文' THEN 0 WHEN r.availability='PDF原件' THEN 1 ELSE 2 END, r.year DESC,r.title,r.id LIMIT ? OFFSET ?`).all(...params,...rankParams,pageSize,(page-1)*pageSize);
    return {items:rows.map(card),total,page,pageSize,pages};
  }
  get(id){
    const row=this.db.prepare(`SELECT r.*,${ING_COLS} FROM library_resources r LEFT JOIN library_ingestion i ON i.resource_id=r.id WHERE r.id=?`).get(id);if(!row)return null;
    const assets=this.db.prepare('SELECT a.id,a.size,a.mime,ra.label name,ra.role FROM library_resource_assets ra JOIN library_assets a ON a.id=ra.asset_id WHERE ra.resource_id=? ORDER BY CASE ra.role WHEN \'primary\' THEN 0 ELSE 1 END,ra.label').all(id);
    return {...card({...row,pdf:assets.some(a=>a.mime==='application/pdf'&&a.role==='primary'),asset_count:assets.length}),bodyHTML:safeHTML(row.body_html),text:row.body_text,assets,problemKeys:this.db.prepare('SELECT problem_key FROM library_problems WHERE resource_id=?').all(id).map(x=>x.problem_key),related:this.related(id)};
  }
  related(id){
    const rows=this.db.prepare(`SELECT DISTINCT r.*,
      EXISTS(SELECT 1 FROM library_problems a JOIN library_problems b ON a.problem_key=b.problem_key WHERE a.resource_id=? AND b.resource_id=r.id) same_problem
      FROM library_resources r WHERE r.id<>? AND (
       EXISTS(SELECT 1 FROM library_problems a JOIN library_problems b ON a.problem_key=b.problem_key WHERE a.resource_id=? AND b.resource_id=r.id)
       OR EXISTS(SELECT 1 FROM library_methods a JOIN library_methods b ON a.method_key=b.method_key WHERE a.resource_id=? AND b.resource_id=r.id)
      ) ORDER BY same_problem DESC,CASE r.kind WHEN '赛题' THEN 0 WHEN '论文' THEN 1 WHEN '代码' THEN 2 WHEN '讲评' THEN 3 ELSE 4 END,r.availability='在线索引',r.title LIMIT 100`).all(id,id,id,id);
    return rows.map(r=>({...card(r),basis:r.same_problem?'同赛题':'同方法'}));
  }
  asset(id){const row=this.db.prepare('SELECT * FROM library_assets WHERE id=?').get(id);if(!row)return null;const file=path.resolve(this.dir,row.path);if(!file.startsWith(this.dir+path.sep))throw new AppError(500,'资料路径无效。');return {...row,file};}
  ingestionList(){return {active:this.db.prepare("SELECT count(*) n FROM library_ingestion WHERE status IN('queued','parsing')").get().n,items:this.db.prepare(`SELECT r.id,r.title,r.category,${ING_COLS} FROM library_ingestion i JOIN library_resources r ON r.id=i.resource_id ORDER BY i.updated_at DESC LIMIT 12`).all().map(r=>({id:r.id,title:r.title,category:r.category,ingestion:ingestion(r)}))};}
  insertResource(row){
    const cols=['id','source_key','title','category','kind','availability','summary','body_html','body_text','contest','year','problem','method','tags_json','source_label','source_url','note','created_at','updated_at'];
    this.db.prepare(`INSERT INTO library_resources(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')}) ON CONFLICT(source_key) DO UPDATE SET ${cols.filter(k=>!['id','source_key','created_at'].includes(k)).map(k=>k+'=excluded.'+k).join(',')}`).run(...cols.map(k=>row[k]??(k==='year'?null:'')));
  }
  close(){this.db.close();}
}
module.exports={LibraryStore,safeHTML,card};
