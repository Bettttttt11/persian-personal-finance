import { DEFAULT_CURRENCY, SCHEMA_VERSION, bool, currencyCode, digitsEn, json, moneyFa, normalizeText, nowIso, safeJsonParse, tehranTime, toRial, uuid } from './utils.js';
import { report, personSummary, queryTransactions, summarize } from './reports.js';
import { parseDateInput } from './jalali.js';
import { calculateSplit } from './business.js';

const OR='https://openrouter.ai/api/v1';
const MODEL_KEYS={text:'OPENROUTER_TEXT_MODEL',vision:'OPENROUTER_VISION_MODEL',audio:'OPENROUTER_AUDIO_MODEL',file:'OPENROUTER_FILE_MODEL'};
const ALLOWED_ACTIONS=new Set(['create_transaction','edit_transaction','delete_transaction','create_person','create_project','pay_installment','settle_debt']);
const CASH_TYPES=new Set(['expense','income','transfer','installment_payment','receivable','refund']);
let catalogCache={until:0,data:null};

async function fetchTimed(url,opt={},ms=18000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms);
  try{return await fetch(url,{...opt,signal:controller.signal});}
  catch(e){if(e?.name==='AbortError')throw new Error('AI_TIMEOUT');throw e}
  finally{clearTimeout(timer)}
}
async function modelCatalog(env){
  if(catalogCache.data&&Date.now()<catalogCache.until)return catalogCache.data;
  const response=await fetchTimed(`${OR}/models`,{headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`}},10000);let body={};try{body=await response.json();}catch{}
  if(!response.ok||!Array.isArray(body.data)){const e=new Error('AI_FAILED');e.status=response.status;e.detail=String(body?.error?.message||'OpenRouter model catalog failed').slice(0,180);throw e;}
  catalogCache={until:Date.now()+15*60*1000,data:body.data};return body.data;
}
export async function modelId(repo,env,kind){
  const saved=await repo.setting(`openrouter_${kind}_model`,null),savedId=typeof saved==='string'?saved.trim():'',envId=String(env[MODEL_KEYS[kind]]||'').trim();
  return savedId||envId||(kind==='text'&&env.OPENROUTER_API_KEY?'openrouter/free':'');
}
export async function getCapabilities(repo,env){
  if(repo._aiCapabilities)return repo._aiCapabilities;
  const out={configured:!!env.OPENROUTER_API_KEY,text:false,vision:false,audio:false,file:false,models:{},requested_models:{},fallback_used:false,error:''};
  if(!env.OPENROUTER_API_KEY)return(repo._aiCapabilities=out);
  const ids={};for(const kind of Object.keys(MODEL_KEYS)){ids[kind]=await modelId(repo,env,kind);out.requested_models[kind]=ids[kind];}
  if(ids.text==='openrouter/free'){out.text=true;out.models.text={id:'openrouter/free',known:true,router:true,structured:true,supported_parameters:['structured_outputs','response_format']};}
  const needsCatalog=Object.entries(ids).some(([kind,id])=>id&&(kind!=='text'||id!=='openrouter/free'));
  if(!needsCatalog)return(repo._aiCapabilities=out);
  let data=[];try{data=await modelCatalog(env);}catch(e){out.error=e.detail||e.message;if(ids.text&&!out.text){out.text=true;out.models.text={id:ids.text,known:false,structured:false,supported_parameters:[]};}return(repo._aiCapabilities=out);}
  const byId=new Map(data.map(x=>[x.id,x]));
  for(const [kind,id] of Object.entries(ids)){
    if(!id||out.models[kind])continue;const model=byId.get(id);
    if(!model){out.models[kind]={id,known:false,structured:false,supported_parameters:[]};if(kind==='text')out.text=true;continue;}
    const input=model.architecture?.input_modalities||[],output=model.architecture?.output_modalities||[],parameters=model.supported_parameters||[];
    out.models[kind]={id,known:true,input_modalities:input,output_modalities:output,supported_parameters:parameters,structured:parameters.includes('structured_outputs')};
    if(kind==='text')out.text=input.includes('text');
    if(kind==='vision')out.vision=input.includes('image');
    if(kind==='audio')out.audio=input.includes('audio')||output.includes('transcription');
    if(kind==='file')out.file=input.includes('file');
  }
  const textModel=byId.get(ids.text);
  if(!out.vision&&textModel?.architecture?.input_modalities?.includes('image')){out.vision=true;out.models.vision={...out.models.text,id:ids.text,fallback:true};}
  if(!out.file&&textModel?.architecture?.input_modalities?.includes('file')){out.file=true;out.models.file={...out.models.text,id:ids.text,fallback:true};}
  return(repo._aiCapabilities=out);
}
async function activeTextModel(repo,env){const id=await modelId(repo,env,'text');if(!env.OPENROUTER_API_KEY||!id)throw new Error('AI_DISABLED');return id;}

async function sendChat(env,body){
  const response=await fetchTimed(`${OR}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'content-type':'application/json','HTTP-Referer':env.PUBLIC_BASE_URL||'https://finance.local','X-Title':'Personal Finance Telegram'},body:JSON.stringify(body)});
  let result={};try{result=await response.json();}catch{}
  if(!response.ok||!result.choices?.[0]?.message){const e=new Error('AI_FAILED');e.status=response.status;e.detail=String(result?.error?.message||'').slice(0,180);throw e;}
  const content=result.choices[0].message.content;if(typeof content==='string')return content;if(Array.isArray(content))return content.map(x=>x?.text||'').join('\n');throw new Error('AI_FAILED');
}
async function chat(repo,env,{model,messages,jsonSchema=null,maxTokens=700,temperature=0.2}){
  if(!env.OPENROUTER_API_KEY||!model)throw new Error('AI_DISABLED');
  const body={model,messages,max_tokens:maxTokens,temperature,provider:{sort:'latency',allow_fallbacks:true}};
  if(jsonSchema){body.response_format={type:'json_schema',json_schema:{name:'finance_response',strict:true,schema:jsonSchema}};body.provider.require_parameters=true;}
  try{return await sendChat(env,body)}catch(first){
    if(first?.message==='AI_TIMEOUT')throw first;
    if(jsonSchema){const fallback={...body,provider:{sort:'latency',allow_fallbacks:true}};delete fallback.response_format;try{return await sendChat(env,fallback)}catch(e){if(e?.message==='AI_TIMEOUT')throw e}}
    if(model!=='openrouter/free'){const fallback={...body,model:'openrouter/free',provider:{...(body.provider||{}),sort:'latency',allow_fallbacks:true}};try{return await sendChat(env,fallback)}catch{}}
    throw first;
  }
}
function extractJson(text){const s=String(text||'').trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();try{return JSON.parse(s);}catch{const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)try{return JSON.parse(s.slice(a,b+1));}catch{}throw new Error('AI_INVALID_JSON');}}
function isPlainObject(x){return !!x&&typeof x==='object'&&!Array.isArray(x);}
const plannerSchema={type:'object',additionalProperties:false,required:['kind'],properties:{kind:{type:'string',enum:['read','actions','split','clarify','chat']},read:{type:['object','null'],properties:{metric:{type:'string'},from:{type:'string'},to:{type:'string'},type:{type:'string'},person_name:{type:'string'},merchant_name:{type:'string'},category_name:{type:'string'},account_name:{type:'string'},project_name:{type:'string'},query:{type:'string'},limit:{type:'integer'}},additionalProperties:true},actions:{type:'array',items:{type:'object',properties:{action:{type:'string'},data:{type:'object',additionalProperties:true}},required:['action','data'],additionalProperties:false}},split:{type:['object','null'],additionalProperties:true},question:{type:'string'},options:{type:'array',items:{type:'string'}},reply:{type:'string'}}};
function validatePlan(plan){if(!isPlainObject(plan)||!['read','actions','split','clarify','chat'].includes(plan.kind))throw new Error('AI_INVALID_JSON');if(plan.kind==='actions'){if(!Array.isArray(plan.actions)||plan.actions.length<1||plan.actions.length>20)throw new Error('AI_INVALID_JSON');for(const action of plan.actions)if(!isPlainObject(action)||!ALLOWED_ACTIONS.has(action.action)||!isPlainObject(action.data))throw new Error('AI_INVALID_JSON');}return plan;}

async function resolveNamed(repo,sheet,name){
  if(!name)return{id:'',ambiguous:false};const field={People:'person_id',Merchants:'merchant_id',Projects:'project_id',Categories:'category_id',Accounts:'account_id',Installments:'installment_id',Debts:'debt_id'}[sheet],rows=await repo.list(sheet,{limit:5000,filter:x=>!bool(x.archived)&&!bool(x.is_deleted)}),q=normalizeText(name);
  const exact=rows.filter(r=>normalizeText(r.name||r.title||'')===q);if(exact.length===1)return{id:exact[0][field],row:exact[0],ambiguous:false};if(exact.length>1)return{ambiguous:true,options:exact.slice(0,8).map(x=>({id:x[field],name:x.name||x.title}))};
  const partial=rows.filter(r=>normalizeText(r.name||r.title||'').includes(q)||q.includes(normalizeText(r.name||r.title||'')));if(partial.length===1)return{id:partial[0][field],row:partial[0],ambiguous:false};if(partial.length>1)return{ambiguous:true,options:partial.slice(0,8).map(x=>({id:x[field],name:x.name||x.title}))};return{id:'',ambiguous:false};
}
async function compactEntityContext(repo){
  if(typeof repo.prefetch==='function')await repo.prefetch(['Accounts','Categories','People','Projects','Merchants','Installments','Transactions']);
  const defs=[['Accounts','account_id','accounts'],['Categories','category_id','categories'],['People','person_id','people'],['Projects','project_id','projects'],['Merchants','merchant_id','merchants'],['Installments','installment_id','installments']];const out={};
  const results=await Promise.all(defs.map(async([sheet,id,key])=>{let rows=await repo.list(sheet,{limit:100,filter:x=>!bool(x.archived)&&!bool(x.is_deleted)});if(sheet==='Installments')rows=rows.filter(x=>x.status!=='completed');return[key,rows.slice(0,40).map(x=>({id:x[id],name:x.name||x.title||'',status:x.status||undefined,favorite:bool(x.favorite)||undefined}))]}));
  for(const [key,rows] of results)out[key]=rows;
  const txs=await queryTransactions(repo,{});out.recent_transactions=txs.slice(0,24).map(t=>({id:t.transaction_id,type:t.type,amount:Number(t.amount||0),date:t.transaction_date_iso,time:t.transaction_time||'00:00:00',description:t.description||'',account_id:t.account_id||'',destination_account_id:t.destination_account_id||'',category_id:t.category_id||'',person_id:t.person_id||'',project_id:t.project_id||'',merchant_id:t.merchant_id||''}));
  out.defaults={account_id:await repo.setting('default_account',''),today:parseDateInput('امروز'),yesterday:parseDateInput('دیروز'),now_time:tehranTime(),currency:currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY))};return out;
}
export async function planUserText(repo,env,text,history=[]){
  const model=await activeTextModel(repo,env),context=await compactEntityContext(repo),recent=(Array.isArray(history)?history:[]).slice(-8).map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'').slice(0,900)}));
  const prompt=`تو دستیار مالی شخصی فارسی، صمیمی و دقیق هستی. فقط JSON معتبر مطابق schema برگردان.\nقواعد:\n- سؤال درباره سوابق مالی = kind=read. برای سؤال‌هایی مثل «دیروز چی خوردم؟»، «آخرین خرج‌هام چی بوده؟» یا «برای اسنپ چقدر دادم؟» از metric=search و فیلترهای from/to/category_name/merchant_name/type/query استفاده کن تا کد روی تراکنش‌های واقعی جستجو کند؛ جواب را از خودت نساز.\n- ثبت/ویرایش/حذف/پرداخت = kind=actions و فقط پیشنهاد؛ اجرا بعد از تأیید صریح کاربر است. delete_transaction فقط وقتی کاربر صریحاً حذف تراکنش می‌خواهد و transaction_id باید از recent_transactions باشد.\n- اگر کاربر به «این/همون/قبلی» اشاره کرد از recent_transactions و تاریخچه استفاده کن.\n- اگر اطلاعات اجباری یک اقدام کم است kind=clarify و فقط همان سؤال لازم را بپرس.\n- تاریخ نگفته = امروز ${context.defaults.today}. دیروز = ${context.defaults.yesterday}.\n- اگر حساب نگفته و default account وجود دارد همان ID را بگذار. اگر حساب پیش‌فرض نیست، account_id را خالی بگذار؛ سیستم بعداً اگر فقط یک حساب باشد خودکار پر می‌کند و اگر چند حساب باشد سؤال می‌پرسد.\n- واحد پیش‌فرض وقتی کاربر واحد نگفته ${context.defaults.currency==='TOMAN'?'تومان':'ریال'} است. اگر صریحاً «تومان/تومن» گفت currency=TOMAN و اگر «ریال» گفت currency=IRR. هرگز برای تبدیل واحد صفر اضافه/کم نکن: عدد amount دقیقاً در همان واحدی باشد که کاربر گفته؛ تبدیل را کد انجام می‌دهد. مثال: «100 هزار تومان» => amount=100000,currency=TOMAN و «1.5 میلیون ریال» => amount=1500000,currency=IRR.\n- زمان فعلی تهران ${context.defaults.now_time} است. اگر کاربر زمان انجام تراکنش را گفت، transaction_time را HH:MM:SS بگذار. مثال اگر الان بعد از 16:00 است و گفت «ساعت 4 گرفتم»، منظور آخرین ساعت 4 گذشته یعنی 16:00:00 است، مگر صبح/شب را صریح گفته باشد.\n- create_transaction type یکی از expense,income,transfer,installment_payment,debt,receivable,refund,adjustment. برای transfer مبدا account_id و مقصد destination_account_id جدا و متفاوت باشند.\n- برای شناسه‌ها فقط IDهای context را استفاده کن. اگر نام حساب/دسته/شخص/پروژه/فروشنده را فهمیدی می‌توانی همراه ID فیلد name متناظر هم بدهی.\n- برای سلام و گپ kind=chat و reply طبیعی کوتاه بده.\nmetricهای read: summary, top_expense, search, person, merchant.\nactionهای مجاز: create_transaction, edit_transaction, delete_transaction, create_person, create_project, pay_installment, settle_debt.\ncontext: ${JSON.stringify(context)}\nمتن جدید: ${text}`;
  const messages=[{role:'system',content:'فقط JSON معتبر مطابق schema بده؛ بدون Markdown.'},...recent,{role:'user',content:prompt}];
  let raw;try{raw=await chat(repo,env,{model,messages,jsonSchema:plannerSchema,maxTokens:950,temperature:0.1});return validatePlan(extractJson(raw));}catch(first){if(first?.message!=='AI_INVALID_JSON')throw first;raw=await chat(repo,env,{model,messages:[{role:'system',content:'فقط یک شیء JSON معتبر بده؛ بدون توضیح.'},...recent,{role:'user',content:prompt}],maxTokens:800,temperature:0});return validatePlan(extractJson(raw));}
}

async function resolveReadFilters(repo,r){
  const filters={};for(const key of ['from','to'])if(r[key]){try{filters[key]=parseDateInput(r[key])}catch{filters[key]=r[key]}}
  if(r.type)filters.type=r.type;if(r.query)filters.q=r.query;
  for(const [nameKey,sheet,idKey] of [['person_name','People','person_id'],['merchant_name','Merchants','merchant_id'],['category_name','Categories','category_id'],['account_name','Accounts','account_id'],['project_name','Projects','project_id']]){
    if(!r[nameKey])continue;const found=await resolveNamed(repo,sheet,r[nameKey]);if(found.ambiguous)return{clarify:`کدام ${nameKey==='person_name'?'شخص':nameKey==='merchant_name'?'فروشنده':nameKey==='category_name'?'دسته':nameKey==='account_name'?'حساب':'پروژه'}؟`,options:found.options,entity:nameKey.replace('_name','')};if(found.id)filters[idKey]=found.id;else if(!filters.q)filters.q=r[nameKey];
  }
  return{filters};
}
async function executeRead(repo,plan){
  const r=plan.read||{};
  if(r.metric==='person'){const person=await resolveNamed(repo,'People',r.person_name);if(person.ambiguous)return{clarify:'کدام شخص؟',options:person.options,entity:'person'};if(!person.id)return{data:{found:false,person:r.person_name}};return{data:await personSummary(repo,person.id),label:person.row.name};}
  if(r.metric==='merchant'){const merchant=await resolveNamed(repo,'Merchants',r.merchant_name);if(merchant.ambiguous)return{clarify:'کدام فروشنده؟',options:merchant.options,entity:'merchant'};const rr=await resolveReadFilters(repo,r);if(rr.clarify)return rr;const tx=await queryTransactions(repo,{...rr.filters,merchant_id:merchant.id});return{data:{count:tx.length,transactions:tx.slice(0,30),summary:summarize(tx)},label:merchant.row?.name||r.merchant_name};}
  const rr=await resolveReadFilters(repo,r);if(rr.clarify)return rr;const filters=rr.filters||{};
  if(r.metric==='top_expense'){const tx=await queryTransactions(repo,filters),item=tx.filter(t=>t.type==='expense'||t.type==='installment_payment').sort((a,b)=>Number(b.amount)-Number(a.amount))[0]||null;return{data:{transaction:item}};}
  if(r.metric==='search'){const tx=await queryTransactions(repo,filters),limit=Math.max(1,Math.min(30,Number(r.limit||12)));return{data:{count:tx.length,transactions:tx.slice(0,limit),summary:summarize(tx)}};}
  return{data:await report(repo,filters)};
}
function deterministicReadText(result,currency=DEFAULT_CURRENCY){
  if(result.clarify)return result.clarify;const d=result.data;
  if(Array.isArray(d?.transactions)&&d.count!==undefined){if(!d.transactions.length)return'موردی با این مشخصات پیدا نکردم.';const lines=d.transactions.slice(0,8).map(t=>`• ${t.transaction_date||t.transaction_date_iso||''} ${t.transaction_time||''} — ${t.description||'بدون شرح'} — ${moneyFa(Number(t.amount||0),currency)}`);return`${Number(d.count).toLocaleString('fa-IR')} مورد پیدا کردم:\n${lines.join('\n')}${d.count>8?'\n…':''}`;}
  if(d?.summary){const s=d.summary;return`خرج خالص ${moneyFa(s.net_expense||0,currency)}، درآمد ${moneyFa(s.income||0,currency)}، کارمزد ${moneyFa(s.fees||0,currency)}.`;}
  if(d?.transaction){const t=d.transaction;return t?`بیشترین مورد: ${t.description||'بدون شرح'} — ${moneyFa(t.amount||0,currency)}.`:'موردی پیدا نشد.';}
  if(d?.receivable!==undefined)return`طلب باز: ${moneyFa(d.receivable,currency)}، بدهی باز: ${moneyFa(d.debt,currency)}.`;if(d?.count!==undefined)return`${d.count.toLocaleString('fa-IR')} مورد پیدا شد.`;return'اطلاعات پیدا شد.';
}
function normalizeAiSplit(split,currency){const x={...(split||{})};x.total_amount=toRial(Number(x.total_amount||0),currency);x.items=(x.items||[]).map(i=>({...i,paid_amount:toRial(Number(i.paid_amount||0),currency),share_value:x.mode==='custom'?toRial(Number(i.share_value||0),currency):i.share_value}));return x;}
async function friendlyChat(repo,env,text,history=[]){const model=await activeTextModel(repo,env),recent=(Array.isArray(history)?history:[]).slice(-8).map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'').slice(0,900)}));return sanitizeAiText(await chat(repo,env,{model,messages:[{role:'system',content:'فارسی، صمیمی، کوتاه و کاربردی جواب بده. تو دستیار مالی شخصی هستی. هیچ ثبت یا حذف را بدون تأیید انجام نده.'},...recent,{role:'user',content:text}],maxTokens:300,temperature:0.4}));}

const FA_NUM={صفر:0,یک:1,یه:1,دو:2,سه:3,چهار:4,پنج:5,شش:6,هفت:7,هشت:8,نه:9,ده:10,یازده:11,دوازده:12,سیزده:13,چهارده:14,پانزده:15,شانزده:16,هفده:17,هجده:18,نوزده:19,بیست:20,سی:30,چهل:40,پنجاه:50,شصت:60,هفتاد:70,هشتاد:80,نود:90,صد:100,یکصد:100,دویست:200,سیصد:300,چهارصد:400,پانصد:500,ششصد:600,هفتصد:700,هشتصد:800,نهصد:900};
function persianNumberWords(value=''){const tokens=normalizeText(value).split(/\s+/).filter(x=>x&&x!=='و'),mult={هزار:1e3,میلیون:1e6,میلیارد:1e9};let total=0,group=0,seen=false;for(const token of tokens){if(mult[token]){if(!seen&&group===0)return null;total+=(group||1)*mult[token];group=0;seen=true;continue}if(FA_NUM[token]===undefined)return null;group+=FA_NUM[token];seen=true}const n=total+group;return seen&&Number.isSafeInteger(n)&&n>0?n:null;}
export function explicitMoneyMentions(text=''){
  const clean=digitsEn(String(text||'')).replace(/[٬,،_]/g,'').replace(/٫/g,'.'),out=[],numeric=/(\d+(?:\.\d+)?)\s*(هزار|میلیون|میلیارد)?\s*(تومان|تومن|ریال)/g;let m;
  while((m=numeric.exec(clean))){const scale=m[2]==='هزار'?1e3:m[2]==='میلیون'?1e6:m[2]==='میلیارد'?1e9:1,value=Number(m[1])*scale;if(!Number.isSafeInteger(value)||value<=0)continue;const before=clean.slice(Math.max(0,m.index-24),m.index),fee=/کارمزد/.test(before);out.push({amount:value,currency:/تومان|تومن/.test(m[3])?'TOMAN':'IRR',fee,index:m.index,end:numeric.lastIndex});}
  const words='(?:صفر|یک|یه|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|یکصد|دویست|سیصد|چهارصد|پانصد|ششصد|هفتصد|هشتصد|نهصد|هزار|میلیون|میلیارد|و)',wordRe=new RegExp(`(${words}(?:\\s+${words})*)\\s*(تومان|تومن|ریال)`,'g');
  while((m=wordRe.exec(normalizeText(clean)))){const value=persianNumberWords(m[1]);if(!value)continue;const start=m.index,end=wordRe.lastIndex;if(out.some(x=>start<x.end&&end>x.index))continue;const before=normalizeText(clean).slice(Math.max(0,start-24),start),fee=/کارمزد/.test(before);out.push({amount:value,currency:/تومان|تومن/.test(m[2])?'TOMAN':'IRR',fee,index:start,end});}
  return out.sort((a,b)=>a.index-b.index).map(({end,...x})=>x);
}
export function inferNaturalTransactionTime(text='',now=new Date()){
  const clean=digitsEn(String(text||'')).replace(/٫/g,':'),current=tehranTime(now).split(':').map(Number),currentMinutes=current[0]*60+current[1];let m=clean.match(/ساعت\s*(\d{1,2})(?:[:.]([0-5]?\d))?(?:[:.]([0-5]?\d))?\s*(صبح|بامداد|ظهر|عصر|بعدازظهر|شب)?/);
  if(!m)m=clean.match(/(?:^|\s)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:\s|$)/);if(!m)return'';
  let h=Number(m[1]),mi=Number(m[2]||0),se=Number(m[3]||0),part=m[4]||'';if(h>23||mi>59||se>59)return'';
  if(part){if(/عصر|بعدازظهر|شب/.test(part)&&h<12)h+=12;else if(part==='ظهر'&&h<12)h=h===12?12:h+12;else if(/صبح|بامداد/.test(part)&&h===12)h=0;}
  else if(h>=1&&h<=12){const candidates=[h===12?0:h,h===12?12:h+12],past=candidates.filter(x=>x*60+mi<=currentMinutes);h=past.length?past[past.length-1]:candidates[0];}
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(se).padStart(2,'0')}`;
}
function convertUnit(value,from,to){if(from===to)return value;return from==='TOMAN'&&to==='IRR'?value*10:value/10;}
function applyUserMoneyAndTime(actions,text,defaultCurrency){
  const list=(actions||[]).map(a=>({action:a.action,data:{...(a.data||{})}})),mentions=explicitMoneyMentions(text),main=mentions.filter(x=>!x.fee),fees=mentions.filter(x=>x.fee),time=inferNaturalTransactionTime(text);let mi=0,fi=0;
  for(const a of list){if(a.action!=='create_transaction'&&a.action!=='pay_installment'&&a.action!=='settle_debt')continue;const x=a.data;if(main[mi]){x.amount=main[mi].amount;x.currency=main[mi].currency;mi++;}else x.currency=x.currency||defaultCurrency;if(fees[fi]){x.fee_amount=Math.round(convertUnit(fees[fi].amount,fees[fi].currency,x.currency||defaultCurrency));fi++;}if(time&&!x.transaction_time)x.transaction_time=time;}
  return list;
}
async function namedId(repo,sheet,data,idKey,nameKey){if(data[idKey])return String(data[idKey]);if(!data[nameKey])return'';const r=await resolveNamed(repo,sheet,data[nameKey]);if(r.ambiguous)return{ambiguous:true,options:r.options};return r.id||'';}
async function normalizeAction(repo,action){
  const x={...(action.data||{})},currency=currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY));
  if(action.action==='create_transaction'){
    x.type=String(x.type||'expense');x.currency=x.currency||currency;if(!x.transaction_date&&!x.transaction_date_iso)x.transaction_date=parseDateInput('امروز');
    for(const [sheet,idKey,nameKey] of [['Accounts','account_id','account_name'],['Accounts','destination_account_id','destination_account_name'],['Categories','category_id','category_name'],['People','person_id','person_name'],['Projects','project_id','project_name'],['Merchants','merchant_id','merchant_name']]){const id=await namedId(repo,sheet,x,idKey,nameKey);if(isPlainObject(id)&&id.ambiguous)return{clarify:`${x[nameKey]} چند مورد دارد؛ دقیق‌تر انتخاب کن.`,options:id.options.map(o=>o.name)};if(id)x[idKey]=id;}
    if(CASH_TYPES.has(x.type)&&!x.account_id){const accounts=await repo.list('Accounts',{limit:500,filter:a=>!bool(a.archived)&&!bool(a.is_deleted)}),def=String(await repo.setting('default_account','')||''),valid=accounts.find(a=>String(a.account_id)===def);if(valid)x.account_id=valid.account_id;else if(accounts.length===1)x.account_id=accounts[0].account_id;else return{clarify:'این تراکنش از کدام حساب ثبت شود؟',options:accounts.slice(0,8).map(a=>a.name)};}
    if(x.type==='transfer'){if(!x.destination_account_id){const accounts=await repo.list('Accounts',{limit:500,filter:a=>!bool(a.archived)&&!bool(a.is_deleted)&&String(a.account_id)!==String(x.account_id)});if(accounts.length===1)x.destination_account_id=accounts[0].account_id;else return{clarify:'انتقال به کدام حساب مقصد است؟',options:accounts.slice(0,8).map(a=>a.name)};}if(String(x.account_id)===String(x.destination_account_id))return{clarify:'حساب مبدا و مقصد انتقال نمی‌توانند یکی باشند.',options:[]};}
    if(['debt','receivable'].includes(x.type)&&!x.person_id)return{clarify:'این بدهی/طلب مربوط به چه شخصی است؟',options:(await repo.list('People',{limit:100,filter:p=>!bool(p.archived)&&!bool(p.is_deleted)})).slice(0,8).map(p=>p.name)};
    if(!Number.isSafeInteger(Number(x.amount))||Number(x.amount)<=0)return{clarify:'مبلغ این تراکنش چقدر است؟',options:[]};
  }else if(action.action==='edit_transaction'||action.action==='delete_transaction'){
    if(!x.transaction_id)return{clarify:'کدام تراکنش را می‌خواهی تغییر بدهم؟',options:[]};const tx=await repo.getById('Transactions',x.transaction_id);if(!tx||bool(tx.is_deleted))return{clarify:'آن تراکنش را در سوابق فعال پیدا نکردم.',options:[]};if(action.action==='edit_transaction'&&!isPlainObject(x.patch))return{clarify:'چه چیزی از این تراکنش را تغییر بدهم؟',options:[]};
  }else if(action.action==='create_person'&&!String(x.name||'').trim())return{clarify:'اسم شخص جدید چیست؟',options:[]};
  else if(action.action==='create_project'&&!String(x.name||'').trim())return{clarify:'اسم پروژه جدید چیست؟',options:[]};
  else if(action.action==='pay_installment'){if(!x.installment_id)return{clarify:'پرداخت مربوط به کدام برنامه قسط است؟',options:[]};if(x.amount!==undefined&&x.amount!==null&&x.amount!==''&&(!Number.isSafeInteger(Number(x.amount))||Number(x.amount)<=0))return{clarify:'مبلغ پرداخت قسط چقدر است؟',options:[]};}
  else if(action.action==='settle_debt'){if(!x.debt_id)return{clarify:'کدام بدهی یا طلب را می‌خواهی تسویه کنی؟',options:[]};if(!Number.isSafeInteger(Number(x.amount))||Number(x.amount)<=0)return{clarify:'مبلغ تسویه چقدر است؟',options:[]};}
  else if(!ALLOWED_ACTIONS.has(action.action))throw new Error('AI_INVALID_ACTION');
  return{action:{action:action.action,data:x}};
}
export async function normalizeAiActions(repo,actions=[],sourceText=''){const currency=currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY)),prepared=applyUserMoneyAndTime(actions,sourceText,currency),out=[];for(const item of prepared){const n=await normalizeAction(repo,item);if(n.clarify)return n;out.push(n.action);}return{actions:out};}

const FOOD_TERMS=['غذا','خوراک','ناهار','شام','صبحانه','رستوران','کافه','فست فود','فستفود','پیتزا','ساندویچ','برگر','قهوه','چای','سوپرمارکت','سوپر مارکت','تنقلات','میان وعده'];
async function fastHistoryRead(repo,text){
  const q=normalizeText(text),food=/(چی|چه).*(خوردم|خوردیم|غذا|ناهار|شام|صبحانه)|(خوردم|خوردیم).*(چی|چه)/.test(q),day=q.includes('دیروز')?'دیروز':q.includes('امروز')?'امروز':'';if(!food||!day)return null;const date=parseDateInput(day),txs=await queryTransactions(repo,{from:date,to:date,type:'expense'}),[cats,merchants]=await Promise.all([repo.list('Categories',{limit:5000}),repo.list('Merchants',{limit:5000})]),cat=Object.fromEntries(cats.map(x=>[x.category_id,x.name||''])),mer=Object.fromEntries(merchants.map(x=>[x.merchant_id,x.name||''])),items=txs.filter(t=>{const hay=normalizeText([t.description,cat[t.category_id],mer[t.merchant_id]].join(' '));return FOOD_TERMS.some(w=>hay.includes(normalizeText(w)))}),currency=currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY));return{kind:'read',text:sanitizeAiText(deterministicReadText({data:{count:items.length,transactions:items,summary:summarize(items)}},currency)),data:{count:items.length,transactions:items,summary:summarize(items)},fast_path:true};
}

export async function handleAiText(repo,env,text,history=[]){
  const fast=await fastHistoryRead(repo,text);if(fast)return fast;
  let plan;try{plan=await planUserText(repo,env,text,history);}catch(error){try{return{kind:'chat',text:await friendlyChat(repo,env,text,history),fallback:true};}catch{throw error;}}
  if(plan.kind==='read'){const result=await executeRead(repo,plan);if(result.clarify)return{kind:'clarify',text:result.clarify,options:result.options,entity:result.entity||''};const currency=currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY));return{kind:'read',text:sanitizeAiText(deterministicReadText(result,currency)),data:result.data};}
  if(plan.kind==='split'){try{const currency=currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY));return{kind:'split',result:calculateSplit(normalizeAiSplit(plan.split,currency))}}catch{return{kind:'clarify',text:'اطلاعات دنگ کامل نیست؛ مبلغ کل، افراد و پرداختی هر نفر را بگو.'}}}
  if(plan.kind==='actions'){
    const normalized=await normalizeAiActions(repo,plan.actions,text);if(normalized.clarify)return{kind:'clarify',text:normalized.clarify,options:normalized.options||[]};
    const proposal=await repo.insert('Drafts',{draft_id:uuid(),kind:'ai_actions',owner_telegram_id:String(env.OWNER_TELEGRAM_ID),state_json:json({text,actions:normalized.actions,executed:{}}),status:'active',created_at:nowIso(),updated_at:nowIso(),expires_at:new Date(Date.now()+24*3600e3).toISOString(),schema_version:SCHEMA_VERSION});
    return{kind:'actions',draft_id:proposal.draft_id,actions:normalized.actions,text:plan.reply||''};
  }
  if(plan.kind==='chat'&&!plan.reply)plan.reply=await friendlyChat(repo,env,text,history);return{kind:plan.kind,text:sanitizeAiText(plan.reply||plan.question||'یکم بیشتر توضیح می‌دی؟'),options:plan.options||[]};
}

export async function getAiDraft(repo,draftId){const draft=await repo.getById('Drafts',draftId);if(!draft||draft.kind!=='ai_actions')throw new Error('NOT_FOUND');const state=safeJsonParse(draft.state_json,{});return{draft,state,actions:Array.isArray(state.actions)?state.actions:[]};}
export async function removeAiAction(repo,draftId,index){const {draft,state,actions}=await getAiDraft(repo,draftId);if(draft.status!=='active')throw new Error('NOT_FOUND');if(isPlainObject(state.executed)&&Object.keys(state.executed).length)throw new Error('AI_PARTIAL_EXECUTION');const i=Number(index);if(!Number.isInteger(i)||i<0||i>=actions.length)throw new Error('VALIDATION');actions.splice(i,1);if(!actions.length){await repo.updateById('Drafts',draftId,{state_json:json({...state,actions}),status:'discarded'},{action:'ai_remove_all'});return{draft_id:draftId,actions:[],status:'discarded'};}await repo.updateById('Drafts',draftId,{state_json:json({...state,actions}),updated_at:nowIso()},{audit:false});return{draft_id:draftId,actions,status:'active'};}
export async function reviseAiActions(repo,env,draftId,instruction,history=[]){
  const {draft,state}=await getAiDraft(repo,draftId);if(draft.status!=='active')throw new Error('NOT_FOUND');if(isPlainObject(state.executed)&&Object.keys(state.executed).length)throw new Error('AI_PARTIAL_EXECUTION');if(!String(instruction||'').trim())throw new Error('VALIDATION');
  const text=`پیشنهاد فعلی من این است: ${JSON.stringify(state.actions||[])}\nدرخواست اصلاح کاربر: ${instruction}\nفقط نسخه اصلاح‌شده اقدام‌ها را برگردان. اگر کاربر خواست یک مورد حذف شود آن را از لیست حذف کن.`;
  const plan=await planUserText(repo,env,text,history);if(plan.kind==='clarify')return{kind:'clarify',text:plan.question||plan.reply||'چه چیزی را اصلاح کنم؟',options:plan.options||[]};if(plan.kind!=='actions')throw new Error('AI_INVALID_ACTION');const normalized=await normalizeAiActions(repo,plan.actions,`${state.text||''} ${instruction}`);if(normalized.clarify)return{kind:'clarify',text:normalized.clarify,options:normalized.options||[]};
  const next={...state,actions:normalized.actions,last_revision:String(instruction).slice(0,1000),executed:{}};await repo.updateById('Drafts',draftId,{state_json:json(next),updated_at:nowIso()},{audit:false});return{kind:'actions',draft_id:draftId,actions:normalized.actions};
}
function requirePositiveInt(value){return Number.isSafeInteger(Number(value))&&Number(value)>0;}
async function executeAiAction(repo,finance,action){
  if(!ALLOWED_ACTIONS.has(action.action)||!isPlainObject(action.data))throw new Error('AI_INVALID_ACTION');const x=action.data,currency=currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY));
  if(action.action==='create_person'){if(!String(x.name||'').trim())throw new Error('VALIDATION');return repo.insert('People',{person_id:uuid(),name:String(x.name).trim(),phone:x.phone||'',note:x.note||'',color:x.color||'',favorite:false,archived:false,is_deleted:false,deleted_at:'',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});}
  if(action.action==='create_project'){if(!String(x.name||'').trim())throw new Error('VALIDATION');return repo.insert('Projects',{project_id:uuid(),name:String(x.name).trim(),description:x.description||'',icon:x.icon||'',color:x.color||'',budget:x.budget?toRial(Number(x.budget),currency):'',start_date:x.start_date||'',end_date:x.end_date||'',status:'active',archived:false,is_deleted:false,deleted_at:'',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});}
  if(action.action==='create_transaction'){if(!requirePositiveInt(x.amount))throw new Error('VALIDATION');if(x.type==='receivable')return finance.createReceivable({...x,date:x.transaction_date||x.transaction_date_iso,source:'ai'});if(x.type==='debt')return finance.createDebt({...x,date:x.transaction_date||x.transaction_date_iso,source:'ai'});return finance.createTransaction(x,'ai');}
  if(action.action==='edit_transaction'){if(!x.transaction_id||!isPlainObject(x.patch))throw new Error('VALIDATION');return finance.editTransaction(x.transaction_id,x.patch);}
  if(action.action==='delete_transaction'){if(!x.transaction_id)throw new Error('VALIDATION');return finance.softDeleteTransaction(x.transaction_id);}
  if(action.action==='pay_installment'){if(!x.installment_id)throw new Error('VALIDATION');return finance.payInstallment(x.installment_id,{...x,source:'ai'});}
  if(action.action==='settle_debt'){if(!x.debt_id)throw new Error('VALIDATION');return finance.settleDebt(x.debt_id,{...x,source:'ai'});}
  throw new Error('AI_INVALID_ACTION');
}
export async function confirmAiActions(repo,finance,draftId){
  const {draft,state,actions}=await getAiDraft(repo,draftId);if(draft.status==='confirmed')return Array.isArray(state.confirmed_results)?state.confirmed_results:[];if(draft.status!=='active')throw new Error('NOT_FOUND');
  const normalized=await normalizeAiActions(repo,actions,state.text||'');if(normalized.clarify){const e=new Error('AI_NEEDS_CLARIFICATION');e.detail=normalized.clarify;throw e;}
  const results=[],executed=isPlainObject(state.executed)?{...state.executed}:{};
  for(let i=0;i<normalized.actions.length;i++){
    const action=normalized.actions[i],key=`ai:${draftId}:${i}`;let result;
    if(executed[i])result=executed[i];else{result=await repo.idempotent(key,'ai_action',()=>executeAiAction(repo,finance,action));executed[i]=result;await repo.updateById('Drafts',draftId,{state_json:json({...state,actions:normalized.actions,executed}),updated_at:nowIso()},{audit:false});}
    results.push(result);
  }
  const finalState={...state,actions:normalized.actions,executed,confirmed_results:results};await repo.updateById('Drafts',draftId,{state_json:json(finalState),status:'confirmed'},{action:'ai_confirm'});await repo.audit('Drafts',draftId,'AI-write',draft,{...draft,status:'confirmed'});return results;
}
export function sanitizeAiText(value=''){return String(value).replace(/```[\s\S]*?```/g,'').replace(/\*\*|__|###?|`/g,'').replace(/\n{3,}/g,'\n\n').trim().slice(0,3500);}
export function aiErrorText(error){const m=String(error?.message||'');if(m==='AI_DISABLED')return'مدل متنی OpenRouter تنظیم نشده است.';if(m==='AI_TIMEOUT')return'مدل هوش مصنوعی بیش از حد طول کشید؛ دوباره تلاش کن یا یک مدل سریع‌تر انتخاب کن.';if(m==='AI_NEEDS_CLARIFICATION')return error?.detail||'برای انجام این کار یک اطلاعات دیگر لازم است.';if(m==='AI_PARTIAL_EXECUTION')return'بخشی از این پیشنهاد قبلاً اجرا شده است؛ برای جلوگیری از ثبت تکراری، اول تأیید را دوباره بزن تا ادامه همان عملیات کامل شود.';if(m==='AI_INVALID_JSON')return'مدل پاسخ ساختاری نامعتبر داد؛ دوباره با جمله ساده‌تر امتحان کن.';if(m==='AI_FAILED')return'OpenRouter پاسخ قابل استفاده نداد. نام مدل و اعتبار API Key را بررسی کن.';return'دستیار فعلاً نتوانست پاسخ بدهد. دوباره امتحان کن.';}
function bytesToB64(bytes){let s='';const u=new Uint8Array(bytes);for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode(...u.subarray(i,i+0x8000));return btoa(s);}

export async function extractReceipt(repo,env,bytes,mime='image/webp'){
  const caps=await getCapabilities(repo,env);if(!caps.vision)throw new Error('AI_DISABLED');const model=caps.models.vision.id,dataUrl=`data:${mime};base64,${bytesToB64(bytes)}`;
  const schema={type:'object',additionalProperties:false,properties:{amount:{type:['integer','null']},date:{type:['string','null']},merchant:{type:['string','null']},fee:{type:['integer','null']},tracking_number:{type:['string','null']},reference_number:{type:['string','null']},description:{type:['string','null']}},required:['amount','date','merchant','fee','tracking_number','reference_number','description']};
  const currency=currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY)),label=currency==='TOMAN'?'تومان':'ریال';const raw=await chat(repo,env,{model,messages:[{role:'system',content:`از تصویر رسید فقط داده‌های قابل مشاهده را استخراج کن. حدس نزن. مبلغ را به ${label} و عدد صحیح برگردان.`},{role:'user',content:[{type:'text',text:'اطلاعات رسید را JSON استخراج کن.'},{type:'image_url',image_url:{url:dataUrl}}]}],jsonSchema:schema,maxTokens:400}),x=extractJson(raw);
  if(x.amount!==null&&!Number.isSafeInteger(x.amount))throw new Error('AI_INVALID_JSON');if(x.fee!==null&&!Number.isSafeInteger(x.fee))throw new Error('AI_INVALID_JSON');return x;
}
export async function transcribeAudio(repo,env,bytes,format='ogg'){
  const caps=await getCapabilities(repo,env),model=await modelId(repo,env,'audio');if(!caps.audio||!model||!env.OPENROUTER_API_KEY)throw new Error('AI_DISABLED');
  const response=await fetchTimed(`${OR}/audio/transcriptions`,{method:'POST',headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({input_audio:{data:bytesToB64(bytes),format},model,language:'fa'})},30000);let result={};try{result=await response.json();}catch{}if(!response.ok||!result.text)throw new Error('AI_FAILED');return result.text;
}
const bankRowsSchema={type:'object',additionalProperties:false,required:['rows'],properties:{rows:{type:'array',items:{type:'object',additionalProperties:false,required:['date','amount','description','tracking_number','reference_number','bank_transaction_id','type'],properties:{date:{type:'string'},amount:{type:'integer'},description:{type:'string'},tracking_number:{type:'string'},reference_number:{type:'string'},bank_transaction_id:{type:'string'},type:{type:'string'}}}}}};
export async function analyzePdf(repo,env,bytes,fileName='statement.pdf'){
  const caps=await getCapabilities(repo,env),model=caps.file?caps.models.file.id:'';if(!model||!env.OPENROUTER_API_KEY)throw new Error('AI_DISABLED');const data=`data:application/pdf;base64,${bytesToB64(bytes)}`;
  const currency=currencyCode(await repo.setting('default_currency',DEFAULT_CURRENCY)),label=currency==='TOMAN'?'تومان':'ریال';const raw=await chat(repo,env,{model,messages:[{role:'system',content:`ردیف‌های بانکی قابل مشاهده را بدون حدس استخراج کن. amount به ${label} و عدد صحیح مثبت باشد. type فقط expense,income,transfer,refund. اگر مقدار وجود ندارد رشته خالی بده.`},{role:'user',content:[{type:'text',text:'صورتحساب بانکی را به rows استاندارد تبدیل کن.'},{type:'file',file:{filename:fileName,file_data:data}}]}],jsonSchema:bankRowsSchema,maxTokens:1800}),parsed=extractJson(raw);
  if(!Array.isArray(parsed.rows))throw new Error('AI_INVALID_JSON');for(const row of parsed.rows){if(!Number.isSafeInteger(row.amount)||row.amount<=0)throw new Error('AI_INVALID_JSON');if(!['expense','income','transfer','refund'].includes(row.type))row.type='expense';}return parsed;
}
