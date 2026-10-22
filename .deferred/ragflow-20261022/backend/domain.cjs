'use strict';
const CATEGORIES=Object.freeze(['数学建模理论','历年竞赛题目','优秀数学建模论文','算法与代码','论文规范与评价','教学与训练']);
const SCOPES=Object.freeze(['个人资料','公开资料','校内资料','教师私有']);
const SUPPORTED=new Set(['.pdf','.doc','.docx','.ppt','.pptx','.txt','.md','.markdown','.tex','.csv','.tsv','.json','.py','.m','.r','.js','.html','.htm','.ipynb','.xlsx','.xls','.srt','.vtt','.bib']);
const STATUS_LABELS={queued:'等待解析',uploading:'正在提交',parsing:'正在解析',ready:'可检索',error:'解析失败',needs_unpack:'需先解包',unsupported:'仅保存原件'};
class AppError extends Error {constructor(status,message){super(message);this.status=status;}}
function fields(input){
  const result={};
  for(const [key,max] of [['category',80],['scope',40],['tags',1000],['description',12000]]){
    const value=input[key]??(key==='scope'?'个人资料':'');
    if(typeof value!=='string'||value.length>max||value.includes('\0'))throw new AppError(400,'资料字段无效：'+key);
    result[key]=value.trim();
  }
  if(!CATEGORIES.includes(result.category))throw new AppError(400,'请选择原有六类中的一个分类。');
  if(!SCOPES.includes(result.scope))throw new AppError(400,'资料分区无效。');
  return result;
}
function docStatus(doc){
  const run=String(doc.run??doc.run_status??'').toUpperCase();
  if(['FAIL','FAILED','ERROR','4'].includes(run)||Number(doc.progress)<0)return 'error';
  if(['DONE','SUCCESS','3'].includes(run)||Number(doc.progress)>=1)return 'ready';
  if(['CANCEL','CANCELED','2'].includes(run))return 'error';
  return 'parsing';
}
function publicResource(row){return {id:row.id,name:row.name,size:row.size,type:row.mime,kind:'knowledge',category:row.category,scope:row.scope,tags:row.tags,description:row.description,text:row.preview||'',createdAt:row.created_at,updatedAt:row.updated_at,backend:'ragflow',status:row.status,statusLabel:STATUS_LABELS[row.status]||row.status,error:row.error||'',chunkCount:row.chunk_count||0};}
module.exports={CATEGORIES,SCOPES,SUPPORTED,STATUS_LABELS,AppError,fields,docStatus,publicResource};
