import katex from 'katex';
import renderMathInElement from 'katex/contrib/auto-render';
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import matlab from 'highlight.js/lib/languages/matlab';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import r from 'highlight.js/lib/languages/r';
import bash from 'highlight.js/lib/languages/bash';
for(const [name,syntax] of Object.entries({python,matlab,javascript,json,r,bash}))hljs.registerLanguage(name,syntax);
function enhance(prose){
  if(prose.dataset.enhanced)return;prose.dataset.enhanced='true';
  // All text remains source text. Code is never evaluated and KaTeX trust stays disabled.
  renderMathInElement(prose,{delimiters:[{left:'$$',right:'$$',display:true},{left:'\\[',right:'\\]',display:true},{left:'\\(',right:'\\)',display:false},{left:'$',right:'$',display:false}],throwOnError:false,trust:false,strict:'ignore',maxExpand:500,maxSize:20,errorCallback:()=>{}});
  const toc=document.querySelector('#kb-toc');
  prose.querySelectorAll('h1,h2,h3,h4').forEach((heading,i)=>{
    heading.id='kb-heading-'+i;
    if(toc){const b=document.createElement('button');b.className='kb-toc-link';b.type='button';b.textContent=heading.textContent;b.dataset.kb='jump';b.dataset.target=heading.id;toc.append(b);}
  });
  prose.querySelectorAll('table').forEach(table=>{const wrap=document.createElement('div');wrap.className='kb-table-scroll';table.replaceWith(wrap);wrap.append(table);});
  prose.querySelectorAll('pre').forEach((pre,index)=>{
    const code=pre.querySelector('code')||pre,text=code.textContent;
    const specified=(code.className.match(/language-([\w-]+)/)||[])[1]||pre.dataset.language||'';
    let lang=specified;
    if(!lang&&/(?:^|\n)\s*(?:import |from \w+ import |def |print\()/m.test(text))lang='python';
    if(!lang&&/(?:^|\n)\s*(?:clear;|clc;|function |% )/m.test(text))lang='matlab';
    if(lang&&hljs.getLanguage(lang)){code.innerHTML=hljs.highlight(text,{language:lang,ignoreIllegals:true}).value;code.classList.add('hljs');}
    const wrap=document.createElement('div');wrap.className='kb-code-wrap';const bar=document.createElement('div');bar.className='kb-code-bar';
    const name=document.createElement('span');name.textContent=lang||'文本 / 输出';bar.append(name);
    const controls=document.createElement('div');
    const copy=document.createElement('button');copy.type='button';copy.textContent='复制';copy.setAttribute('aria-label','复制代码块 '+(index+1));
    copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(text);copy.textContent='已复制';setTimeout(()=>copy.textContent='复制',1600);}catch{copy.textContent='请选中后复制';}});
    const save=document.createElement('button');save.type='button';save.textContent='下载';save.setAttribute('aria-label','下载代码块 '+(index+1));
    save.addEventListener('click',()=>{const ext={python:'py',matlab:'m',javascript:'js',json:'json',r:'r',bash:'sh'}[lang]||'txt';window.MM.download(text,'代码片段-'+(index+1)+'.'+ext);});
    controls.append(copy,save);bar.append(controls);pre.replaceWith(wrap);wrap.append(bar,pre);
  });
}
window.LibraryReader={enhance};
