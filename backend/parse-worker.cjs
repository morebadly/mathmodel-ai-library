'use strict';
const {parentPort,workerData}=require('node:worker_threads');
// Parsing is local only. Block outbound networking even if a parser changes defaults.
const deny=()=>{throw new Error('REMOTE_RESOURCE_DISABLED');};
for(const name of ['node:http','node:https']){const mod=require(name);mod.request=deny;mod.get=deny;}
require('node:net').connect=deny;require('node:net').createConnection=deny;globalThis.fetch=deny;
const {parseDocument,parseError}=require('./parse-document.cjs');
parseDocument(workerData.file,workerData.name).then(result=>parentPort.postMessage(result)).catch(error=>parentPort.postMessage({status:'error',format:'',text:'',html:'',message:parseError(error)}));
