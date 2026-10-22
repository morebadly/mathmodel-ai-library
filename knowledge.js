'use strict';
(() => {
  const M=window.MM;
  async function request(url,options={}){
    let res;try{res=await fetch(url,{...options,signal:options.signal||AbortSignal.timeout(120000)});}catch{throw new Error('本地资料服务未响应，请使用本地启动器打开平台。');}
    let data;try{data=await res.json();}catch{throw new Error('资料服务返回了无效响应。');}
    if(!res.ok)throw new Error(data.error||'资料请求未完成。');return data;
  }
  M.library={
    stats:()=>request('/api/library/stats'),
    list:filters=>request('/api/library/resources?'+new URLSearchParams(Object.entries(filters||{}).filter(([,v])=>v!==''&&v!=null))),
    get:async id=>(await request('/api/library/resources/'+encodeURIComponent(id))).item,
    ingestion:()=>request('/api/library/ingestion'),
    reparse:id=>request('/api/library/resources/'+encodeURIComponent(id)+'/reparse',{method:'POST'}),
    async upload(file,metadata){
      const tags=String(metadata.tags||'').split(/[,，;；\s]+/).filter(Boolean),note=String(metadata.description||'');
      if(tags.length>40||tags.some(x=>x.length>80))throw new Error('标签最多 40 个，每个不超过 80 字。');
      if(note.length>12000)throw new Error('资料说明不能超过 12,000 字。');
      const data=await request('/api/library/resources?'+new URLSearchParams({name:file.name,category:metadata.category||'auto'}),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file,signal:AbortSignal.timeout(10*60*1000)});
      if(tags.length||note)await this.update(data.item.id,{tags,note});
      return data;
    },
    update:(id,body)=>request('/api/library/resources/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
    assetURL:(id,inline=false)=>'/api/library/assets/'+encodeURIComponent(id)+(inline?'?inline=1':'')
  };
  const localFile=M.getFile;
  M.getFile=async id=>{
    const restored=await localFile(id);if(restored)return restored;
    if(!String(id).startsWith('kb_'))return restored;
    const item=await M.library.get(id),asset=item.assets.find(a=>a.role==='primary')||item.assets[0];
    if(!asset)throw new Error('这条记录是资料索引，没有本地原件。');
    const response=await fetch(M.library.assetURL(asset.id));if(!response.ok)throw new Error('附件读取失败。');return response.blob();
  };
})();
