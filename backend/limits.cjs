'use strict';
// Byte limits are optional: 0 means no application-level file-size ceiling.
const TEXT_FILE=/\.(txt|md|markdown|html?|py|r|m|tex|js|ts|tsx|jsx|c|cpp|h|java|jl|sql|sh|ipynb|json|csv|tsv|bib|srt|vtt)$/i;
function readByteLimit(env,name){
  const raw=env[name];if(raw===undefined||raw==='')return 0;
  const value=Number(raw);if(!Number.isSafeInteger(value)||value<0)throw new Error(name+' 必须为非负整数字节数，0 表示不设文件大小上限。');
  return value;
}
function loadLimits(env=process.env){return {maxUploadBytes:readByteLimit(env,'MM_MAX_UPLOAD_BYTES'),maxTextUploadBytes:readByteLimit(env,'MM_MAX_TEXT_UPLOAD_BYTES'),maxParseBytes:readByteLimit(env,'MM_MAX_PARSE_BYTES')};}
function uploadLimit(limits,name){const values=[limits.maxUploadBytes,TEXT_FILE.test(name)?limits.maxTextUploadBytes:0].filter(x=>x>0);return values.length?Math.min(...values):0;}
module.exports={loadLimits,uploadLimit,TEXT_FILE};
