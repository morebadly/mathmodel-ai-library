'use strict';
const path=require('node:path'),{Worker}=require('node:worker_threads');
const {classify,associations,kindFor}=require('./classify.cjs');
class IngestionQueue{
  constructor(store,{timeoutMs=120000}={}){this.store=store;this.timeoutMs=timeoutMs;this.active=null;this.closed=false;store.db.prepare("UPDATE library_ingestion SET status='queued' WHERE status='parsing'").run();this.kick();}
  enqueue(id,{mode='manual'}={}){
    const r=this.store.db.prepare('SELECT title,category FROM library_resources WHERE id=?').get(id);if(!r)return;
    const c=classify(r.title);this.store.db.prepare(`INSERT INTO library_ingestion(resource_id,status,category_mode,confidence,needs_review,reason,updated_at) VALUES(?,'queued',?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET status='queued',message='',updated_at=excluded.updated_at`).run(id,mode,mode==='manual'?'manual':c.confidence,mode==='manual'?0:1,mode==='manual'?'按手动指定分类保存。':c.reason,new Date().toISOString());this.kick();
  }
  kick(){if(this.closed||this.active)return;setImmediate(()=>this.drain());}
  async drain(){
    if(this.closed||this.active)return;
    const row=this.store.db.prepare(`SELECT r.id,r.title,ra.label name,a.path FROM library_ingestion i JOIN library_resources r ON r.id=i.resource_id JOIN library_resource_assets ra ON ra.resource_id=r.id AND ra.role='primary' JOIN library_assets a ON a.id=ra.asset_id WHERE i.status='queued' ORDER BY i.updated_at LIMIT 1`).get();if(!row)return;
    this.active={id:row.id,worker:null};this.store.db.prepare("UPDATE library_ingestion SET status='parsing',attempts=attempts+1,updated_at=? WHERE resource_id=?").run(new Date().toISOString(),row.id);
    let result;
    try{
      const file=path.resolve(this.store.dir,row.path);if(!file.startsWith(this.store.dir+path.sep))throw new Error('invalid path');
      const worker=new Worker(path.join(__dirname,'parse-worker.cjs'),{workerData:{file,name:row.name},resourceLimits:{maxOldGenerationSizeMb:512,stackSizeMb:8},stdout:true,stderr:true});
      this.active.worker=worker;worker.stdout.resume();worker.stderr.resume();
      result=await new Promise(resolve=>{let done=false;const finish=r=>{if(done)return;done=true;clearTimeout(timer);resolve(r);};const fail=message=>finish({status:'error',text:'',html:'',format:'',message});const timer=setTimeout(()=>fail('解析超过 120 秒，原件已保留；请拆分文档或重新解析。'),this.timeoutMs);worker.once('message',finish);worker.once('error',()=>fail('解析进程异常或资源不足，原件已保留，请拆分后重试。'));worker.once('exit',()=>fail('解析进程提前结束，原件已保留，请重新解析。'));});
      await worker.terminate();
    }catch{result={status:'error',text:'',html:'',format:'',message:'本地解析暂未成功，原件已保留，可重新解析。'};}
    if(!this.closed){try{this.finish(row.id,result);}catch{this.store.db.prepare("UPDATE library_ingestion SET status='error',message=?,updated_at=? WHERE resource_id=?").run('解析结果保存失败，原件已保留，可重新解析。',new Date().toISOString(),row.id);}}
    this.active=null;this.kick();
  }
  finish(id,result){
    const db=this.store.db,old=db.prepare('SELECT r.*,i.category_mode,i.format FROM library_resources r JOIN library_ingestion i ON i.resource_id=r.id WHERE r.id=?').get(id);if(!old)return;
    const text=result.text||'',html=result.html||'',now=new Date().toISOString();
    // A retry must never replace readable content or its metadata with an empty result.
    if(!text&&(old.body_text||old.body_html)){
      db.prepare('UPDATE library_ingestion SET status=?,format=?,char_count=?,message=?,updated_at=? WHERE resource_id=?').run(result.status,result.format||old.format||'',old.body_text.length,result.message+' 已保留现有正文与分类，仍可阅读和检索。',now,id);
      return;
    }
    const guess=classify(old.title,text),manual=old.category_mode==='manual',category=manual?old.category:guess.category;
    const links=associations(old.title,text),format=result.format||old.format||'';
    db.exec('BEGIN IMMEDIATE');try{
      db.prepare('UPDATE library_resources SET category=?,kind=?,availability=?,summary=?,body_html=?,body_text=?,updated_at=? WHERE id=?').run(category,kindFor(category,old.title,format),format==='pdf'||old.availability==='PDF原件'?'PDF原件':text?'本地正文':'附件包',text?text.replace(/\s+/g,' ').slice(0,180):result.message,html,text,now,id);
      db.prepare('UPDATE library_ingestion SET status=?,format=?,char_count=?,message=?,confidence=?,needs_review=?,reason=?,updated_at=? WHERE resource_id=?').run(result.status,format,text.length,result.message,manual?'manual':guess.confidence,manual?0:Number(guess.review),manual?'按手动指定分类保存。':guess.reason,now,id);
      if(result.format==='pdf')db.prepare("UPDATE library_assets SET mime='application/pdf' WHERE id IN(SELECT asset_id FROM library_resource_assets WHERE resource_id=? AND role='primary')").run(id);
      // Only member uploads gain inferred relations; imported historical classifications stay intact.
      if(old.source_key.startsWith('upload:')){
        db.prepare('DELETE FROM library_problems WHERE resource_id=?').run(id);db.prepare('DELETE FROM library_methods WHERE resource_id=?').run(id);
        for(const key of links.problems)db.prepare('INSERT OR IGNORE INTO library_problems VALUES(?,?)').run(id,key);
        for(const key of links.methods)db.prepare('INSERT OR IGNORE INTO library_methods VALUES(?,?)').run(id,key);
        if(links.problems.length===1){const [contest,year,problem]=links.problems[0].split(':');db.prepare('UPDATE library_resources SET contest=?,year=?,problem=? WHERE id=?').run(contest==='CUMCM'?'国赛':contest,Number(year),problem,id);}else db.prepare("UPDATE library_resources SET contest='',year=NULL,problem='' WHERE id=?").run(id);
      }
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  async close(){this.closed=true;if(this.active){const id=this.active.id;await this.active.worker?.terminate();this.store.db.prepare("UPDATE library_ingestion SET status='queued',message='等待下次启动继续解析。' WHERE resource_id=? AND status='parsing'").run(id);} }
}
module.exports={IngestionQueue};
