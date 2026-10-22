'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {extractHTML}=require('./html-text.cjs');
const {safeHTML}=require('./library-store.cjs');
const {CODE}=require('./classify.cjs');
const MAX_BYTES=64*1024*1024,MAX_CHARS=1000000;
const esc=s=>String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const plainHTML=text=>text.split(/\n\s*\n/).filter(Boolean).map(p=>'<p>'+esc(p).replace(/\n/g,'<br>')+'</p>').join('\n');
function decodeText(buffer){
  if(buffer[0]===0xff&&buffer[1]===0xfe)return buffer.subarray(2).toString('utf16le');
  if(buffer[0]===0xfe&&buffer[1]===0xff)return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{return new TextDecoder('gb18030').decode(buffer);}
}
async function parseDocument(file,name){
  const ext=path.extname(name).slice(1).toLowerCase(),size=(await fs.stat(file)).size;
  const handle=await fs.open(file,'r'),head=Buffer.alloc(12);try{await handle.read(head,0,12,0);}finally{await handle.close();}
  let format=ext,text='',html='',warnings=[];
  if(head.subarray(0,5).toString()==='%PDF-')format='pdf';
  if(format==='zip'||['rar','7z','mp4','webm','mp3','wav','png','jpg','jpeg','gif'].includes(format))return {status:'saved_only',format,message:format==='zip'?'ZIP 原包已保存，按当前设置不自动展开。':'原件已保存，该格式当前不提取正文。',text:'',html:''};
  if(size>MAX_BYTES)return {status:'saved_only',format,message:'原件已保存；单份文档超过 64 MB 本地解析上限，请拆分后重试。',text:'',html:''};
  const binary=await fs.readFile(file);
  const ole=head.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex'));
  const officeTypes=new Set(['pdf','docx','pptx','xlsx','odt','odp','ods','rtf']);
  if(ole){
    if(format!=='doc')return {status:'saved_only',format,message:'旧版二进制 Office 原件已保存；请另存为 DOCX、PPTX 或 XLSX 后上传解析。',text:'',html:''};
    const WordExtractor=require('word-extractor');const doc=await new WordExtractor().extract(binary);text=doc.getBody()+'\n'+doc.getTextboxes({includeHeadersAndFooters:false});html=plainHTML(text);format='doc';
  }else if(officeTypes.has(format)||head.subarray(0,2).toString()==='PK'&&format!=='zip'){
    const office=require('officeparser');
    const ast=await office.parseOffice(binary,{fileType:officeTypes.has(format)?format:undefined,ocr:false,allowRemoteAssets:false,extractAttachments:false,includeRawContent:false,serializeRawContent:false,ignoreHeadersAndFooters:true,ignoreSlideMasters:true,
      pdfWorkerSrc:pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href,pdfParserConfig:{separateProcess:false,extractTextColor:false,maxTimeMs:15000},
      decompressionLimits:{maxUncompressedBytes:128*1024*1024,maxZipEntries:3000,maxTableCells:50000,maxXmlElements:300000,maxRepeatedContent:2*1024*1024}});
    format=ast.type||format;text=String((await ast.to('text',{includeImages:'none',textConfig:{preserveLayout:false,renderNotes:false}})).value||'');
    warnings=(ast.warnings||[]).map(w=>w.code||w.type||'').filter(Boolean);
    if(text.length<=MAX_CHARS){try{html=String((await ast.to('html',{allowRemoteAssets:false,includeImages:'none',includeFormatting:false,htmlConfig:{renderMetadata:false}})).value||'');}catch{html=plainHTML(text);}}
  }else if(CODE.test(name)||['txt','md','markdown','tex','bib','csv','tsv','json','html','htm','srt','vtt'].includes(format)){
    const raw=decodeText(binary);if(raw.includes('\0'))return {status:'error',format,message:'文件内容与文本格式不符；原件已保留，请核对文件格式。',text:'',html:''};
    text=/^html?$/.test(format)?extractHTML(raw):raw;
    if(CODE.test(name))html='<pre data-language="'+({py:'python',m:'matlab',r:'r',js:'javascript',json:'json',sh:'bash'}[format]||'')+'"><code>'+esc(text.slice(0,MAX_CHARS))+'</code></pre>';
    else if(['md','markdown'].includes(format)){
      const office=require('officeparser');const ast=await office.parseOffice(Buffer.from(raw),{fileType:'md',ocr:false,allowRemoteAssets:false,extractAttachments:false});html=String((await ast.to('html',{allowRemoteAssets:false,includeImages:'none',includeFormatting:false})).value||'');
    }else html=plainHTML(text.slice(0,MAX_CHARS));
  }else return {status:'saved_only',format,message:'原件已保存，该格式当前不提取正文。',text:'',html:''};
  text=text.replace(/\u0000/g,'').replace(/\r\n/g,'\n').trim();
  if(!text.replace(/[\s\u200b-\u200f]/g,''))return {status:format==='pdf'?'needs_ocr':'saved_only',format,message:format==='pdf'?'未提取到文字层，可能是扫描件；已保留 PDF 预览，需要 OCR 后才能搜索正文。':'未提取到可读正文，原件已保存。',text:'',html:''};
  const truncated=text.length>MAX_CHARS||warnings.some(w=>/LIMIT|TRUNCATED|NOT_READ|PAGE_LOAD_FAILED|TEXT_ENCODING_SUSPECT/i.test(w));
  if(text.length>MAX_CHARS){text=text.slice(0,MAX_CHARS);html=plainHTML(text);}
  html=safeHTML(html||plainHTML(text));
  return {status:truncated?'partial':'ready',format,text,html,message:truncated?'已提取部分正文；存在内容限制、页面缺失或文字编码异常，请结合原件阅读。':`已提取 ${text.length.toLocaleString('zh-CN')} 字可检索正文。`,warningCount:warnings.length};
}
function parseError(error){
  const code=error?.officeIssue?.code||error?.code||'',message=String(error?.message||'');
  if(/PASSWORD|ENCRYPT|DECRYPT/i.test(code+' '+message))return '文档已加密或需要密码。请在本机解密后重新上传，原件已保留。';
  if(/LIMIT|TOO_LARGE|MEMORY/i.test(code+' '+message))return '文档超出本地解析资源限制，原件已保留；请拆分后重试。';
  return '正文解析未成功，原件已保留；请核对文件是否损坏、格式是否正确，或重新解析。';
}
module.exports={parseDocument,parseError,MAX_BYTES,MAX_CHARS,plainHTML};
