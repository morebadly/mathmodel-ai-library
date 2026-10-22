'use strict';
(() => {
  const M=window.MM;
  async function request(url,options={}){
    let res;try{res=await fetch(url,{...options,signal:options.signal||AbortSignal.timeout(120000)});}catch{throw new Error('本地知识库服务未响应，请通过本地启动器打开平台。');}
    let data;try{data=await res.json();}catch{throw new Error('知识库服务返回了无效响应。');}
    if(!res.ok)throw new Error(data.error||'知识库请求未完成。');return data;
  }
  const json=(body,method='POST')=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  M.kb={
    status:()=>request('/api/knowledge/status',{signal:AbortSignal.timeout(8000)}),
    list:()=>request('/api/knowledge/resources'),
    configure:body=>request('/api/knowledge/config',json(body,'PUT')),
    async upload(file,metadata){
      const params=new URLSearchParams({name:file.name,category:metadata.category,scope:metadata.scope});
      let result=await request('/api/knowledge/resources?'+params,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal:AbortSignal.timeout(10*60*1000)});
      if(!result.duplicate&&(metadata.tags||metadata.description))result={...result,...await this.update(result.resource.id,metadata)};
      return result;
    },
    update:(id,body)=>request('/api/knowledge/resources/'+encodeURIComponent(id),json(body,'PATCH')),
    retry:id=>request('/api/knowledge/resources/'+encodeURIComponent(id)+'/retry',json({})),
    chunks:id=>request('/api/knowledge/resources/'+encodeURIComponent(id)+'/chunks'),
    retrieve:(question,filters={})=>request('/api/knowledge/retrieve',json({question,...filters})),
    fileURL:id=>'/api/knowledge/resources/'+encodeURIComponent(id)+'/file'
  };
  const localFile=M.getFile;
  M.getFile=async id=>{
    if(!String(id).startsWith('kb_'))return localFile(id);
    let res;try{res=await fetch(M.kb.fileURL(id));}catch{}
    if(res?.ok)return res.blob();
    const saved=await localFile(id);if(saved)return saved;
    throw new Error('无法读取服务端原件，请确认本地知识库服务已启动。');
  };
})();
