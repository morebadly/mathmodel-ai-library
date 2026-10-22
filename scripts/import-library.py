"""Import the user's supplied local corpus. No network, model calls or source-file edits."""
import sys,json,re,sqlite3,zipfile,hashlib,html,copy,os
from pathlib import Path
from datetime import datetime,timezone
from lxml import html as LH,etree
sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT.parent/'outputs'/'平台与知识库评估_20261022'
DL=Path('C:/Users/Administrator/Downloads')
DATA=ROOT/'.data';(DATA/'files').mkdir(parents=True,exist_ok=True)
db=sqlite3.connect(DATA/'library.sqlite');db.executescript((ROOT/'backend/library-schema.sql').read_text(encoding='utf-8'))
now=datetime.now(timezone.utc).isoformat()
classification=json.loads((SOURCE/'classification.json').read_text(encoding='utf-8'))
records={};assets={};links=set();case_titles={};key_primary={};archive_handles={};source_cards={}

def stable(s,prefix='kb_'):return prefix+hashlib.sha256(s.encode()).hexdigest()[:32]
def text_of(markup):
    try:return ' '.join(LH.fromstring('<div>'+markup+'</div>').itertext()).strip()
    except:return markup
def esc(s):return html.escape(str(s))
def clean_name(name):
    name=Path(name).name
    while re.search(r'\.(pdf|zip|rar|doc|xls)\.\1$',name,re.I):name=re.sub(r'\.(pdf|zip|rar|doc|xls)\.\1$',r'.\1',name,flags=re.I)
    return name
def fix_zip_name(info):
    if not info.flag_bits&0x800:
        try:return info.filename.encode('cp437').decode('gb18030')
        except UnicodeError:pass
    return info.filename
def zip_entry(archive,member):
    if archive not in archive_handles:
        z=zipfile.ZipFile(DL/archive);archive_handles[archive]=(z,{fix_zip_name(i):i for i in z.infolist() if not i.is_dir()})
    z,index=archive_handles[archive];return z,index[member]
def asset_stream(stream,name):
    tmp=DATA/'files'/('import-'+hashlib.sha256((name+str(len(assets))).encode()).hexdigest()[:20]+'.tmp')
    h=hashlib.sha256();size=0
    with tmp.open('wb') as out:
        while block:=stream.read(1024*1024):h.update(block);out.write(block);size+=len(block)
    sha=h.hexdigest();dest=DATA/'files'/sha
    if dest.exists():tmp.unlink()
    else:tmp.replace(dest)
    aid='asset_'+sha
    assets[aid]={'id':aid,'sha256':sha,'path':'files/'+sha,'size':size,'mime':'application/pdf' if name.lower().endswith('.pdf') else 'application/octet-stream','original_name':clean_name(name)}
    return aid
def asset_file(p):
    with p.open('rb') as stream:return asset_stream(stream,p.name)
def asset_zip(archive,member):
    z,i=zip_entry(archive,member)
    with z.open(i) as stream:return asset_stream(stream,clean_name(member))
def attach(r,aid,label,role='attachment'):links.add((r['id'],aid,label,role))
def method_key(value):
    s=re.split(r'[：:（(·]',value)[0].strip()
    s=re.sub(r'\s*[A-Za-z].*','',s).strip()
    s=re.sub(r'^\d+[.、\s]*','',s)
    return s if len(s)>=2 else ''
def add_problem(r,key):
    if key not in r['_problems']:r['_problems'].append(key)
    contest,year,letter=key.split(':');r['contest']='国赛' if contest=='CUMCM' else contest;r['year']=int(year);r['problem']=letter
def base(e):
    key=e['记录ID'];kind=e['记录类型'];category=e['主分类'];title=e['标题']
    kinds={'方法卡':'知识卡','训练卡':'训练','算法示例卡':'代码','题目关联代码卡':'代码','教学卡片':'规范' if category=='论文规范与评价' else '训练','题干文本附录':'赛题','在线论文索引':'论文','讲评资料索引':'讲评','PDF原件':'论文','赛题包/附件':'附件','赛题索引/原件':'赛题','会员论文/讲评合并索引':'论文与讲评索引'}
    available='本地正文' if kind in ['方法卡','训练卡','算法示例卡','题目关联代码卡','教学卡片','题干文本附录'] else 'PDF原件' if kind=='PDF原件' else '附件包' if kind=='赛题包/附件' else '在线索引'
    return dict(id='kb_'+key,source_key='source:'+key,title=title,category=category,kind=kinds[kind],availability=available,summary='',body_html='',body_text='',contest='',year=None,problem='',method='',tags_json='[]',source_label=e['来源文件'],source_url=(e['原始链接'] or '').split(';')[0],note=e['备注'],created_at=now,updated_at=now,_problems=[],_methods=[])

for name in ['数学模型-50个常用方法知识卡.html','00-总览.html','00-总览-本轮.html','00-总览效果.html','国赛147题-全流程代码项目集.html']:
    doc=LH.fromstring((DL/name).read_text(encoding='utf-8-sig'))
    cards=doc.xpath('//*[contains(concat(" ",normalize-space(@class)," ")," card ")]')
    if name=='00-总览效果.html':cards=[x for x in cards if x.tag=='article']
    source_cards[name]=cards
teaching=json.loads((SOURCE/'teaching.DATA.json').read_text(encoding='utf-8'))
appendix=json.loads((SOURCE/'teaching.APPENDIX.json').read_text(encoding='utf-8'))
comap=json.loads((SOURCE/'comap_data.json').read_text(encoding='utf-8'))
onlinepapers=json.loads((SOURCE/'国赛历年优秀论文.html.data.DATA.json').read_text(encoding='utf-8'))
comments=json.loads((SOURCE/'国赛赛题讲评资料库.html.data.ROWS.json').read_text(encoding='utf-8'))

for e in classification['entries']:
    r=base(e);source=e['来源文件'];loc=e['来源定位'];kind=e['记录类型'];tags=[x for x in e['标签'].split(';') if x]
    if source in source_cards:
        i=int(re.search(r'卡片\[(\d+)\]',loc)[1])-1;node=copy.deepcopy(source_cards[source][i])
        heads=node.xpath('.//h2|.//h3|.//span[contains(@class,"ttl")]/b|.//div[@class="name"]')
        if heads:
            title_node=copy.deepcopy(heads[0])
            for child in title_node.xpath('.//em'):child.getparent().remove(child)
            r['title']=' '.join(title_node.itertext()).strip()
        for el in node.xpath('.//script|.//style|.//button|.//*[contains(concat(" ",normalize-space(@class)," ")," card-top ")]|.//header[@class="card-hd"]'):
            if el.getparent() is not None:el.getparent().remove(el)
        for el in node.xpath('.//pre'):
            # Mark code blocks without interpreting or running any source code.
            txt=el.text_content()
            if re.search(r'(^|\n)(import |from \w|def |class |#.*Python)',txt):el.set('data-language','python')
        r['body_html']=''.join(etree.tostring(c,encoding='unicode',method='html') for c in node)
        r['body_text']=node.text_content().strip();paras=node.xpath('.//p')
        r['summary']=(' '.join(paras[0].itertext()).strip() if paras else r['body_text'])[:180]
        r['method']=method_key(r['title']);r['_methods']=[r['method']] if r['method'] else []
        urls=node.xpath('.//a[starts-with(@href,"http")]/@href');r['source_url']=urls[0] if urls else ''
        if kind=='题目关联代码卡':
            year,letter=re.search(r'#c-(\d{4})-([A-E])',loc).groups();key='CUMCM:'+year+':'+letter;add_problem(r,key);case_titles[key]=r['title'];tags+=['教学示例','模拟数据需核对']
        elif kind in ['算法示例卡','训练卡']:tags+=['原资料含运行记录','本次未重跑']
    elif source=='数学建模竞赛教学资源库.zip':
        if '::DATA[' in loc:
            i=int(re.search(r'DATA\[(\d+)\]',loc)[1]);x=teaching[i];r['body_html']=x['body'];r['body_text']=text_of(x['body']);r['title']=x['t'];tags += [x['g']]
            if x['cat']=='err':r['kind']='错误案例'
            if x['cat']=='fb':r['kind']='反馈示例';tags+=['训练稿概要','非已核验内部前后稿']
            # Only explicit year+letter in the title establishes a problem relation.
            m=re.search(r'((?:19|20)\d{2}).{0,18}?([A-E])\s*题',x['t'])
            if m:add_problem(r,'CUMCM:'+m[1]+':'+m[2])
        else:
            i=int(re.search(r'APPENDIX\[(\d+)\]',loc)[1]);x=appendix[i]
            r['title']=x['y']+'年国赛'+x['p']+'题';r['body_text']=x['text'];r['body_html']='<div class="problem-text">'+esc(x['text']).replace('\n','<br>')+'</div>'
            key='CUMCM:'+x['y']+':'+x['p'];add_problem(r,key);key_primary[key]=r['id']
            r['source_url']=x.get('url','')
    elif kind=='在线论文索引':
        i=int(re.search(r'DATA\[(\d+)\]',loc)[1]);x=onlinepapers[i];r['title']=x['t'];r['source_url']=x['u'];add_problem(r,f'CUMCM:{x["y"]}:{x["p"]}')
        r['body_html']='<p>此条记录为原论文的在线索引。图片全文和附件保存在来源网站，本地未保存该条目的全文。</p><dl><dt>展示编号</dt><dd>'+esc(x.get('c',''))+'</dd><dt>形式</dt><dd>'+esc(x.get('k',''))+'</dd></dl>'
    elif kind=='讲评资料索引':
        i=int(re.search(r'ROWS\[(\d+)\]',loc)[1]);x=comments[i];r['title']=x['t'];r['source_url']=x['u'];r['year']=x.get('y');r['contest']='国赛';r['kind']='评阅报告' if x['k']=='评阅报告' else '视频讲评' if x['k']=='视频' else '讲评'
        m=re.search(r'((?:19|20)\d{2}).{0,35}?([A-E])\s*题',x['t']) or re.search(r'\(((?:19|20)\d{2})([A-E])\)',x['t'])
        if m:add_problem(r,'CUMCM:'+m[1]+':'+m[2])
        else:r['note']+=' 未根据发布时间自动推断对应赛题。'
        r['body_html']='<p>此资料以标题、作者、定位说明和原文链接登记。可通过原文入口阅读或播放。</p><dl>'+''.join('<dt>'+esc(label)+'</dt><dd>'+esc(x.get(field,''))+'</dd>' for label,field in [('作者','a'),('发布来源','s'),('位置说明','loc'),('来源标注','cr'),('补充说明','note')])+'</dl>'
        r['summary']=x.get('n','')[:180]
    elif kind=='赛题索引/原件':
        i=int(re.search(r'mcm\[(\d+)\]',loc)[1]);x=comap['mcm'][i];key=f'{x["contest"]}:{x["year"]}:{x["problem"]}';add_problem(r,key);key_primary[key]=r['id'];r['source_url']=x.get('problem_url') or ''
        if x.get('prob_local'):
            archive='COMAP_美赛MCM-ICM资源库_v2.zip'
            if archive not in archive_handles:
                z=zipfile.ZipFile(DL/archive);archive_handles[archive]=(z,{fix_zip_name(info):info for info in z.infolist() if not info.is_dir()})
            member=next((n for n in archive_handles[archive][1] if n.endswith('/'+x['prob_local'])),None)
            if member:attach(r,asset_zip(archive,member),Path(x['prob_local']).name,'primary');r['availability']='PDF原件'
        r['body_html']='<p>赛题按赛事、年份和题号登记。'+('本条已提供本地PDF，可在下方直接阅读。' if r['availability']=='PDF原件' else '本条只保存原题索引，本地未包含此题PDF，可从原文入口访问。')+'</p>'
    elif kind=='会员论文/讲评合并索引':
        i=int(re.search(r'mathmodels\[(\d+)\]',loc)[1]);x=comap['mathmodels'][i];add_problem(r,f'{x["contest"]}:{x["year"]}:{x["problem"]}');r['source_url']=x['url']
        r['body_html']=f'<p>这是该题的学生论文与专家讲评目录。目录标注学生论文 {x["papers"]} 篇、讲评 {x["commentary"]} 篇；本地未提供这些正文。</p><p>与所附Excel索引按赛事、年份和题号合并登记。</p>'
    elif kind in ['PDF原件','赛题包/附件']:
        aid=asset_zip(source,loc);attach(r,aid,clean_name(loc),'primary');r['title']=clean_name(loc)
        if kind=='PDF原件':
            m=re.search(r'((?:19|20)\d{2})-([A-E])-',loc)
            if m:add_problem(r,'CUMCM:'+m[1]+':'+m[2])
            r['body_html']='<p>本地PDF原件。文件标题保留原收集命名；合集包含多篇论文，尚未按篇拆分。</p>'
        else:
            m=re.search(r'/((?:19|20)\d{2})/',loc);r['year']=int(m[1]) if m else None;r['contest']='国赛';r['body_html']='<p>本地赛题或数据附件。压缩包需下载解包；附件数量不等于赛题数量。</p>'
    r['body_text']=r['body_text'] or text_of(r['body_html']);r['summary']=r['summary'] or r['body_text'][:180] or r['note'][:180]
    r['tags_json']=json.dumps(list(dict.fromkeys(tags)),ensure_ascii=False);records[r['id']]=r

# Add a problem entrance when only a code/example index previously represented that problem.
for key,title in case_titles.items():
    if key in key_primary:continue
    contest,year,letter=key.split(':');rid=stable('problem:'+key);r=dict(id=rid,source_key='problem:'+key,title=f'{year}年国赛{letter}题 · {title}',category='历年竞赛题目',kind='赛题',availability='题目入口',summary='按原有题目索引建立的阅读入口，可查看同题论文、代码、讲评与本地附件。',body_html='<p>此入口按现有题目索引整理。题干以原题文档或数据附件为准，示例代码不替代赛题原文与完整解答。</p>',body_text=title,contest='国赛',year=int(year),problem=letter,method='',tags_json='[]',source_label='国赛147题-全流程代码项目集.html',source_url='',note='题名取自现有代码索引；同题关系按赛事、年份、题号建立。',created_at=now,updated_at=now,_problems=[key],_methods=[]);records[rid]=r;key_primary[key]=rid

# Link annual problem archives to matching problem entrances; AB/CD documents share their original file.
for r in list(records.values()):
    if r['source_label'].startswith('国赛赛题资料_') and r['year']:
        name=r['title'];year=r['year'];m=re.match(r'^([A-E]{1,2})(?=[-_\s.\d])',name,re.I)
        letters=list(m[1].upper()) if m else list('ABCDE')
        keys=[k for k in key_primary if k.startswith('CUMCM:'+str(year)+':') and k.rsplit(':',1)[-1] in letters]
        if '1992_2000' in name:keys=[k for k in key_primary if k.startswith('CUMCM:') and 1992<=int(k.split(':')[1])<=2000]
        for key in keys:
            if m and key not in r['_problems']:r['_problems'].append(key)
            for rid,aid,label,role in list(links):
                if rid==r['id']:links.add((key_primary[key],aid,('原题/数据附件 · ' if m else '同年或多年共用附件（题号待核对） · ')+label,'attachment'))

# Preserve every locally supplied COMAP results PDF as a shared annual attachment, without calling it a problem PDF.
archive='COMAP_美赛MCM-ICM资源库_v2.zip'
for member in archive_handles[archive][1]:
    m=re.search(r'/results/((?:19|20)\d{2})_(MCM|ICM)_Results\.pdf$',member)
    if not m:continue
    aid=asset_zip(archive,member)
    for key,rid in key_primary.items():
        if key.startswith(m[2]+':'+m[1]+':'):links.add((rid,aid,m[1]+'年'+m[2]+'竞赛结果（共用附件）','attachment'))

# Downloadable source HTML is shared by all cards from that page.
for name in source_cards:
    aid=asset_file(DL/name)
    for r in records.values():
        if r['source_label']==name:attach(r,aid,'来源页面 · '+name,'source')
archive='数学建模竞赛教学资源库.zip'
z=zipfile.ZipFile(DL/archive);info=next(i for i in z.infolist() if not i.is_dir());
with z.open(info) as stream:aid=asset_stream(stream,'数学建模竞赛教学资源库.html')
for r in records.values():
    if r['source_label']==archive:attach(r,aid,'教学资料来源页面.html','source')
z.close()

cols=['id','source_key','title','category','kind','availability','summary','body_html','body_text','contest','year','problem','method','tags_json','source_label','source_url','note','created_at','updated_at']
with db:
    db.executemany('INSERT OR IGNORE INTO library_assets(id,sha256,path,size,mime,original_name) VALUES(:id,:sha256,:path,:size,:mime,:original_name)',assets.values())
    sql='INSERT INTO library_resources('+','.join(cols)+') VALUES('+','.join(':'+c for c in cols)+') ON CONFLICT(source_key) DO UPDATE SET '+','.join(c+'=excluded.'+c for c in cols if c not in ['id','source_key','created_at'])
    db.executemany(sql,records.values())
    # Rebuild only records from this import; member uploads and their relations survive.
    for table in ['library_resource_assets','library_problems','library_methods']:
        db.executemany('DELETE FROM '+table+' WHERE resource_id=?',[(r['id'],) for r in records.values()])
    db.executemany('INSERT OR REPLACE INTO library_resource_assets(resource_id,asset_id,label,role) VALUES(?,?,?,?)',links)
    db.executemany('INSERT OR IGNORE INTO library_problems(resource_id,problem_key) VALUES(?,?)',[(r['id'],k) for r in records.values() for k in r['_problems']])
    db.executemany('INSERT OR IGNORE INTO library_methods(resource_id,method_key) VALUES(?,?)',[(r['id'],k) for r in records.values() for k in r['_methods'] if k])
    db.execute('INSERT OR REPLACE INTO library_meta(key,value) VALUES(?,?)',('last_import',now))
summary={'resources':len(records),'assets':len(assets),'local_pdf':sum(a['mime']=='application/pdf' for a in assets.values()),'asset_bytes':sum(a['size'] for a in assets.values()),'problem_entrances':len(key_primary),'relations':sum(len(r['_problems'])+len(r['_methods']) for r in records.values()),'network_used':False,'source_files_modified':False}
(DATA/'import-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
for z,index in archive_handles.values():z.close()
db.close();print(json.dumps(summary,ensure_ascii=False,indent=2))
