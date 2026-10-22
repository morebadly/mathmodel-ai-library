'use strict';
const {CATEGORIES}=require('./domain.cjs');
const path=require('node:path');
const CODE=/\.(py|m|r|js|ts|tsx|jsx|c|cpp|h|java|jl|sql|sh|ipynb)$/i;
const RULES=[
  [/数学模型|建模理论|方法(?:知识)?卡|线性规划|非线性规划|马尔可夫|主成分分析|层次分析|微分方程|概率论|回归分析|图论|运筹学|优化方法|数值分析/g,'数学建模理论'],
  [/(?:国赛|美赛|高教社杯|MCM|ICM|CUMCM).{0,30}(?:赛题|题目|[A-FＡ-Ｆ]\s*题|problem)|赛题原文|赛题附件|竞赛题目|problem\s+[A-F]\b/gi,'历年竞赛题目'],
  [/优秀论文|获奖论文|参赛论文|建模论文|论文全文|硕士论文|学位论文|研究论文|研究报告|论文(?!规范|格式|写作|评价|评阅|评分)|abstract|关键词.{0,80}参考文献/gi,'优秀数学建模论文'],
  [/算法实现|源代码|代码(?:实现|项目|示例|集)?|编程|python|matlab|jupyter|程序设计/gi,'算法与代码'],
  [/论文规范|论文格式|论文写作|排版规范|评分标准|评阅报告|评价标准|引用规范|文献规范|学术诚信|论文模板|参考文献格式/g,'论文规范与评价'],
  [/教学|课件|讲义|培训|练习|训练|课程|讲评|复盘|入门教程|lecture|tutorial|lesson/gi,'教学与训练']
];
function classify(name,text=''){
  if(CODE.test(name))return {category:CATEGORIES[3],confidence:'high',review:false,reason:'识别为代码文件，按资料用途归入“算法与代码”。'};
  const title=String(name).replace(/\.[^.]+$/,''),body=String(text).slice(0,16000),scores=new Map(CATEGORIES.map(c=>[c,0])),signals=new Map();
  for(const [pattern,category] of RULES){
    const matches=[...title.matchAll(new RegExp(pattern.source,pattern.flags))].map(m=>m[0]);
    const count=[...body.matchAll(new RegExp(pattern.source,pattern.flags))].length;
    scores.set(category,Math.min(3,matches.length)*7+Math.min(5,count));
    signals.set(category,matches[0]||(count?'正文关键词':''));
  }
  // Purpose words take precedence over method names in teaching or writing materials.
  if(/论文(?:规范|格式|写作|评价|评阅|评分|模板)|评分标准|评阅报告/.test(title))scores.set(CATEGORIES[4],scores.get(CATEGORIES[4])+20);
  if(/课件|讲义|培训|练习|训练|教学|讲评/.test(title))scores.set(CATEGORIES[5],scores.get(CATEGORIES[5])+12);
  if(/优秀论文|获奖论文|论文全文/.test(title))scores.set(CATEGORIES[2],scores.get(CATEGORIES[2])+15);
  const ranked=[...scores].sort((a,b)=>b[1]-a[1]),[category,score]=ranked[0],gap=score-ranked[1][1];
  if(score===0)return {category:CATEGORIES[5],confidence:'low',review:true,reason:'文件名和正文的分类线索不足，暂存“教学与训练”，请确认分类。'};
  const confidence=score>=12&&gap>=6?'high':score>=5&&gap>=2?'medium':'low';
  let reason=`根据${signals.get(category)||'资料用途关键词'}归入“${category}”。`;
  if(category===CATEGORIES[2])reason+='归入论文资料类别不代表已认定为优秀或获奖。';
  if(confidence!=='high')reason+='建议确认分类，可随时手动调整。';
  return {category,confidence,review:confidence!=='high',reason};
}
function associations(name,text=''){
  const sample=(name+'\n'+String(text).slice(0,2500)).replace(/[Ａ-Ｆ]/g,x=>String.fromCharCode(x.charCodeAt(0)-65248));
  const problems=new Set(),methods=[];
  let m;
  const english=/(20\d{2})\s*(?:年\s*)?(MCM|ICM)[\s\S]{0,100}?\bProblem\s*([A-F])\b/gi;
  while((m=english.exec(sample)))problems.add(`${m[2].toUpperCase()}:${m[1]}:${m[3].toUpperCase()}`);
  const chinese=/(20\d{2})\s*年?[^\n]{0,24}?(?:国赛|CUMCM|高教社杯|全国大学生数学建模竞赛)[\s\S]{0,100}?([A-E])\s*题/gi;
  while((m=chinese.exec(sample)))problems.add(`CUMCM:${m[1]}:${m[2].toUpperCase()}`);
  for(const method of ['线性规划','非线性规划','整数规划','动态规划','主成分分析','层次分析','马尔可夫链','蒙特卡洛','灰色预测','时间序列','聚类分析','回归分析','微分方程','最小二乘','遗传算法','模拟退火','随机森林','神经网络','图论'])if(sample.includes(method))methods.push(method);
  return {problems:[...problems].slice(0,4),methods:methods.slice(0,5)};
}
function kindFor(category,name,format=''){
  if(category===CATEGORIES[3]||CODE.test(name))return '代码';
  if(category===CATEGORIES[2])return '论文';
  if(category===CATEGORIES[1])return '赛题';
  if(category===CATEGORIES[4])return '规范';
  if(category===CATEGORIES[5])return /讲评/.test(name)?'讲评':'训练';
  return format==='pdf'?'PDF资料':'知识卡';
}
module.exports={classify,associations,kindFor,CODE};
