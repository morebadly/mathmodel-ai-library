'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
class Store {
  constructor(dir){
    this.dir=dir;fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.join(dir,'files'),{recursive:true});fs.mkdirSync(path.join(dir,'tmp'),{recursive:true});
    this.db=new DatabaseSync(path.join(dir,'knowledge.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS resources(
        id TEXT PRIMARY KEY,name TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,
        category TEXT NOT NULL,scope TEXT NOT NULL,tags TEXT NOT NULL,description TEXT NOT NULL,
        status TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',dataset_id TEXT,document_id TEXT,
        preview TEXT NOT NULL DEFAULT '',chunk_count INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(sha256,category,scope));
      CREATE TABLE IF NOT EXISTS datasets(category TEXT PRIMARY KEY,id TEXT NOT NULL,embedding_model TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    // An interrupted upload keeps its upstream ID, so a restart does not re-upload it.
    this.db.prepare("UPDATE resources SET status='queued' WHERE status='uploading'").run();
  }
  list(){return this.db.prepare('SELECT * FROM resources ORDER BY created_at DESC,id').all();}
  get(id){return this.db.prepare('SELECT * FROM resources WHERE id=?').get(id);}
  duplicate(hash,category,scope){return this.db.prepare('SELECT * FROM resources WHERE sha256=? AND category=? AND scope=?').get(hash,category,scope);}
  insert(r){this.db.prepare(`INSERT INTO resources(id,name,sha256,size,mime,category,scope,tags,description,status,preview,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.id,r.name,r.sha256,r.size,r.mime,r.category,r.scope,r.tags,r.description,r.status,r.preview||'',r.created_at,r.created_at);return this.get(r.id);}
  update(id,values,revision){
    const allowed=['name','category','scope','tags','description','status','error','dataset_id','document_id','preview','chunk_count','revision'];
    const pairs=Object.entries(values).filter(([k])=>allowed.includes(k));if(!pairs.length)return this.get(id);
    const result=this.db.prepare(`UPDATE resources SET ${pairs.map(([k])=>k+'=?').join(',')},updated_at=? WHERE id=?${revision===undefined?'':' AND revision=?'}`).run(...pairs.map(([,v])=>v),new Date().toISOString(),id,...(revision===undefined?[]:[revision]));return result.changes?this.get(id):null;
  }
  file(r){return path.join(this.dir,'files',r.sha256);}
  dataset(category){return this.db.prepare('SELECT * FROM datasets WHERE category=?').get(category);}
  saveDataset(category,id,model){this.db.prepare('INSERT INTO datasets(category,id,embedding_model) VALUES(?,?,?) ON CONFLICT(category) DO UPDATE SET id=excluded.id,embedding_model=excluded.embedding_model').run(category,id,model);}
  close(){this.db.close();}
}
module.exports={Store};
