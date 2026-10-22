'use strict';
const path=require('node:path');
const fs=require('node:fs');
const {openAsBlob}=require('node:fs');
const {extractHTML}=require('./html-text.cjs');
const {AppError}=require('./domain.cjs');
class Ragflow {
  constructor(config){this.config=config;}
  async request(route,{method='GET',body,form,timeout=30000}={}){
    const c=this.config();if(!c.apiKey)throw new AppError(503,'RAGFlow 尚未连接，请先完成本地服务配置。');
    let res;try{res=await fetch(c.baseURL+route,{method,headers:{Authorization:'Bearer '+c.apiKey,...(body?{'Content-Type':'application/json'}:{})},body:form|| (body?JSON.stringify(body):undefined),signal:AbortSignal.timeout(timeout)});}catch{throw new AppError(503,'无法连接本地 RAGFlow，请检查服务是否已启动。');}
    let payload;try{payload=await res.json();}catch{throw new AppError(502,'RAGFlow 返回了无法识别的响应。');}
    if(!res.ok||payload.code!==0){
      const detail=typeof payload.message==='string'?payload.message:'请求失败';
      // Upstream may echo a key in errors. Never send that key back to a browser/log.
      const clean=detail.split(c.apiKey).join('[已隐藏]').replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]').slice(0,800);
      throw new AppError(res.status===401||res.status===403?503:502,'RAGFlow：'+clean);
    }
    return payload.data;
  }
  async available(){await this.request('/api/v1/datasets?page=1&page_size=1',{timeout:5000});return true;}
  async dataset(category,store){
    const model=this.config().embeddingModel;
    const existing=store.dataset(category);if(existing){if(existing.embedding_model!==model)throw new AppError(409,'索引模型已固定；更换模型需另建索引，避免混用向量。');return existing.id;}
    const name='MathModel · '+category;
    const list=await this.request('/api/v1/datasets?name='+encodeURIComponent(name)+'&page_size=100');
    let found=(Array.isArray(list)?list:list?.datasets||[]).find(x=>x.name===name);
    if(found?.embedding_model&&found.embedding_model!==model)throw new AppError(409,'已有同名知识库使用不同的向量模型，请确认本地配置。');
    if(!found)found=await this.request('/api/v1/datasets',{method:'POST',body:{name,language:'Chinese',permission:'me',embedding_model:model,parser_id:'general'}});
    if(!found?.id)throw new AppError(502,'RAGFlow 未返回知识库标识。');
    store.saveDataset(category,found.id,model);return found.id;
  }
  async upload(datasetId,resource,file){
    const form=new FormData();let blob,name=resource.id+'-'+resource.name;
    if(/\.html?$/i.test(resource.name)){
      const text=extractHTML(await fs.promises.readFile(file,'utf8'));
      if(!text)throw new AppError(422,'HTML没有可读取的正文或卡片数据。');
      blob=new Blob(['# '+resource.name+'\n\n'+text],{type:'text/markdown'});name=name.replace(/\.html?$/i,'.md');
    }else if(/\.(py|m|r|js|json|ipynb|tex|bib|srt|vtt|tsv)$/i.test(resource.name)){
      blob=await openAsBlob(file);name+='.txt';
    }else blob=await openAsBlob(file,{type:resource.mime||'application/octet-stream'});
    form.append('file',blob,name);
    const result=await this.request('/api/v1/datasets/'+encodeURIComponent(datasetId)+'/documents',{method:'POST',form,timeout:120000});
    const doc=Array.isArray(result)?result[0]:result;
    if(!doc?.id)throw new AppError(502,'RAGFlow 未返回文档标识。');return doc;
  }
  async findDocument(dataset,name){
    const result=await this.request(`/api/v1/datasets/${encodeURIComponent(dataset)}/documents?keywords=${encodeURIComponent(name)}&page_size=100`);
    const expected=/\.html?$/i.test(name)?name.replace(/\.html?$/i,'.md'):/\.(py|m|r|js|json|ipynb|tex|bib|srt|vtt|tsv)$/i.test(name)?name+'.txt':name;
    return (Array.isArray(result)?result:result?.docs||result?.documents||[]).find(d=>d.name===expected);
  }
  parse(dataset,id){return this.request(`/api/v1/datasets/${encodeURIComponent(dataset)}/chunks`,{method:'POST',body:{document_ids:[id]}});}
  async document(dataset,id){
    const result=await this.request(`/api/v1/datasets/${encodeURIComponent(dataset)}/documents?id=${encodeURIComponent(id)}&page_size=1`);
    return (Array.isArray(result)?result:result?.docs||result?.documents||[]).find(d=>d.id===id);
  }
  async chunks(dataset,id){return this.request(`/api/v1/datasets/${encodeURIComponent(dataset)}/documents/${encodeURIComponent(id)}/chunks?page=1&page_size=20`);}
  retrieve(question,datasetIds,documentIds,limit){return this.request('/api/v1/retrieval',{method:'POST',timeout:90000,body:{question,dataset_ids:datasetIds,document_ids:documentIds,page:1,page_size:limit,similarity_threshold:0.15,keywords_similarity_weight:0.7,highlight:false,knn_top_k:64,knn_num_candidates:128,include_knowledge_compilation:false}});}
}
module.exports={Ragflow};
