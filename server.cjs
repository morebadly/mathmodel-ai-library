'use strict';
const {createLibraryApp}=require('./server-library.cjs');
if(require.main===module){
  const port=Number(process.argv[2]||8765);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口需在 1024 到 65535 之间。');
  const app=createLibraryApp();
  app.server.listen(port,'127.0.0.1',()=>console.log(`MathModel AI · 知识库阅读版\nhttp://127.0.0.1:${port}/#knowledge\n本地资料已就绪；RAGFlow 与 Agent 延后，不启动容器或下载模型。`));
  app.server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'端口已被占用，请使用已打开的平台或选择另一端口。':'本地服务启动失败。');app.close().finally(()=>{process.exitCode=1;});});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
}
module.exports={createLibraryApp};
