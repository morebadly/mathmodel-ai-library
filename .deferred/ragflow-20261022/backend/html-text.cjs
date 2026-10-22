'use strict';
// Extract the supplied libraries' JSON data without evaluating any JavaScript.
function decode(s){return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(all,x)=>{
  const map={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(map[x.toLowerCase()]!==undefined)return map[x.toLowerCase()];
  const n=x[1]?.toLowerCase()==='x'?parseInt(x.slice(2),16):parseInt(x.slice(1),10);
  return Number.isFinite(n)&&n>=0&&n<=0x10ffff?String.fromCodePoint(n):all;
});}
function strip(s){return decode(String(s).replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<!--[^]*?-->/g,'').replace(/<\/(?:p|div|li|h[1-6]|section|article|tr|pre)>|<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'')).replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
function arrayAt(s,start){
  let depth=0,quote=false,escape=false;
  for(let i=start;i<s.length;i++){
    const c=s[i];if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false;continue;}
    if(c==='"'){quote=true;continue;}if(c==='['||c==='{')depth++;else if(c===']'||c==='}'){
      depth--;if(depth===0){try{return JSON.parse(s.slice(start,i+1));}catch{return null;}}
    }
  }return null;
}
function extractHTML(s){
  const parts=[];
  for(const m of s.matchAll(/\b(?:var|let|const)\s+(DATA|ROWS|APPENDIX)\s*=\s*(\[)/g)){
    const arr=arrayAt(s,m.index+m[0].length-1);if(!Array.isArray(arr))continue;
    for(const item of arr){if(!item||typeof item!=='object')continue;
      const title=item.t||item.title||item.name||'';
      const body=item.body?strip(item.body):item.text||item.ab||item.description||'';
      const meta=[item.y,item.year,item.p,item.tag,item.g,item.a,item.u,item.url].filter(x=>typeof x==='string'||typeof x==='number').join(' · ');
      if(title||body)parts.push(['## '+title,meta,body].filter(Boolean).join('\n'));
    }
  }
  const visible=strip(s);
  return [visible,...parts].filter(Boolean).join('\n\n').trim();
}
module.exports={extractHTML,strip};
