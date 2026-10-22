'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),runtime=path.join(root,'.runtime'),docker=path.join(runtime,'ragflow','docker');
const template=path.join(docker,'.env');
if(!fs.existsSync(template))throw new Error('请先取得固定版本的RAGFlow docker目录。');
let env=fs.readFileSync(template,'utf8');
const secretFile=path.join(runtime,'service-secrets.json');
let secrets;if(fs.existsSync(secretFile))secrets=JSON.parse(fs.readFileSync(secretFile,'utf8'));else{
  secrets=Object.fromEntries(['MYSQL_PASSWORD','MINIO_PASSWORD','ELASTIC_PASSWORD','REDIS_PASSWORD'].map(k=>[k,crypto.randomBytes(24).toString('hex')]));
  secrets.localAccountPassword=crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(secretFile,JSON.stringify(secrets,null,2),{mode:0o600});
}
const settings={...Object.fromEntries(Object.entries(secrets).filter(([k])=>k.endsWith('_PASSWORD'))),DOC_ENGINE:'elasticsearch',DEVICE:'cpu',MEM_LIMIT:'5368709120',SVR_WEB_HTTP_PORT:'9388',SVR_WEB_HTTPS_PORT:'9443',SVR_HTTP_PORT:'9380',ADMIN_SVR_HTTP_PORT:'9381'};
for(const [key,value] of Object.entries(settings)){
  const re=new RegExp('^'+key+'=.*$','m');env=re.test(env)?env.replace(re,key+'='+value):env+'\n'+key+'='+value;
}
fs.writeFileSync(template,env,{mode:0o600});
const override=`name: mathmodel-ragflow
services:
  es01:
    ports: !reset []
    environment:
      ES_JAVA_OPTS: -Xms1g -Xmx2g
  mysql:
    ports: !reset []
  minio:
    ports: !reset []
  kvrocks:
    ports: !reset []
  nats:
    ports: !reset []
  ragflow-cpu:
    ports: !override
      - 127.0.0.1:9380:9380
      - 127.0.0.1:9388:80
    environment:
      MAX_TASKS: '1'
  ollama:
    image: ollama/ollama:0.40.8
    ports:
      - 127.0.0.1:11434:11434
    environment:
      OLLAMA_NUM_PARALLEL: '1'
      OLLAMA_MAX_LOADED_MODELS: '1'
      HTTP_PROXY: \${MATHMODEL_PROXY_URL:-}
      HTTPS_PROXY: \${MATHMODEL_PROXY_URL:-}
      NO_PROXY: localhost,127.0.0.1,ollama,ragflow-cpu
    volumes:
      - ollama_models:/root/.ollama
    networks:
      - ragflow
    restart: unless-stopped
volumes:
  ollama_models:
`;
fs.writeFileSync(path.join(runtime,'compose.local.yml'),override);
console.log('已生成本地Compose覆盖配置：固定版本、端口仅本机、凭据保存在项目私有目录。');
