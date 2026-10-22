import {getDocument,GlobalWorkerOptions,TextLayer} from '/vendor/pdfjs/build/pdf.min.mjs';
GlobalWorkerOptions.workerSrc='/vendor/pdfjs/build/pdf.worker.min.mjs';
const $=s=>document.querySelector(s),asset=new URLSearchParams(location.search).get('asset');
let pdf,page=1,zoom=null,renderTask=null,textTask=null,sequence=0;
async function draw(){
  if(!pdf)return;const serial=++sequence;
  renderTask?.cancel();textTask?.cancel();
  const current=await pdf.getPage(page);if(serial!==sequence)return;
  const base=current.getViewport({scale:1}),fit=($('#stage').clientWidth-34)/base.width,scale=zoom||fit;
  const viewport=current.getViewport({scale}),dpr=Math.min(devicePixelRatio||1,2),canvas=$('#canvas');
  canvas.width=Math.floor(viewport.width*dpr);canvas.height=Math.floor(viewport.height*dpr);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
  $('#paper').style.width=viewport.width+'px';$('#paper').style.height=viewport.height+'px';$('#paper').style.display='block';
  $('#status').textContent='';$('#page').value=page;$('#prev').disabled=page===1;$('#next').disabled=page===pdf.numPages;$('#scale').textContent=Math.round(scale*100)+'%';$('#stage').setAttribute('aria-busy','true');
  canvas.setAttribute('aria-label',`PDF 第 ${page} 页，共 ${pdf.numPages} 页`);
  renderTask=current.render({canvasContext:canvas.getContext('2d'),viewport,transform:dpr!==1?[dpr,0,0,dpr,0,0]:null});
  try{await renderTask.promise;if(serial!==sequence)return;const layer=$('#text-layer');layer.innerHTML='';layer.style.setProperty('--scale-factor',scale);layer.style.setProperty('--total-scale-factor',scale);textTask=new TextLayer({textContentSource:current.streamTextContent(),container:layer,viewport});await textTask.render();$('#stage').setAttribute('aria-busy','false');}catch(e){if(e.name!=='RenderingCancelledException'&&e.name!=='AbortException'){$('#status').textContent='页面渲染失败，可下载原件阅读。';console.error(e);}}
}
function move(next){page=Math.min(pdf.numPages,Math.max(1,next));draw();$('#stage').scrollTo({top:0});}
$('#prev').onclick=()=>move(page-1);$('#next').onclick=()=>move(page+1);$('#page').onchange=e=>pdf&&move(Number(e.target.value)||1);
$('#plus').onclick=()=>{zoom=Math.min(3.5,(zoom||Number($('#scale').textContent.replace('%',''))/100||1)*1.2);draw();};
$('#minus').onclick=()=>{zoom=Math.max(.3,(zoom||Number($('#scale').textContent.replace('%',''))/100||1)/1.2);draw();};$('#fit').onclick=()=>{zoom=null;draw();};
let resizeTimer;addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(!zoom)draw();},180);});
async function open(){try{if(!/^asset_[a-zA-Z0-9_-]+$/.test(asset||''))throw new Error('PDF 附件标识无效。');const url='/api/library/assets/'+encodeURIComponent(asset);$('#download').href=url;$('#open').href=url+'?inline=1';pdf=await getDocument({url:url+'?inline=1',cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/',wasmUrl:'/vendor/pdfjs/wasm/',iccUrl:'/vendor/pdfjs/iccs/',isEvalSupported:false}).promise;$('#pages').textContent=pdf.numPages;$('#page').max=pdf.numPages;await draw();}catch(e){$('#status').textContent=e.message||'PDF 暂时无法预览，请下载原件。';$('#stage').setAttribute('aria-busy','false');}}
open();
