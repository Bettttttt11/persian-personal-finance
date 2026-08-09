import { SCHEMA_VERSION, json, normalizeText, nowIso, safeJsonParse, uuid } from './utils.js';
import { report, personSummary, queryTransactions, summarize } from './reports.js';
import { parseDateInput } from './jalali.js';
import { calculateSplit } from './business.js';

const OR='https://openrouter.ai/api/v1';
const MODEL_KEYS={text:'OPENROUTER_TEXT_MODEL',vision:'OPENROUTER_VISION_MODEL',audio:'OPENROUTER_AUDIO_MODEL',file:'OPENROUTER_FILE_MODEL'};
const ALLOWED_ACTIONS=new Set(['create_transaction','edit_transaction','create_person','create_project','pay_installment','settle_debt']);

export async function modelId(repo,env,kind){return await repo.setting(`openrouter_${kind}_model`,env[MODEL_KEYS[kind]]||'');}
export async function getCapabilities(repo,env){
  if(repo._aiCapabilities)return repo._aiCapabilities;
  const out={configured:!!env.OPENROUTER_API_KEY,text:false,vision:false,audio:false,file:false,models:{}};
  if(!env.OPENROUTER_API_KEY)return(repo._aiCapabilities=out);
  const ids={};for(const kind of Object.keys(MODEL_KEYS))ids[kind]=await modelId(repo,env,kind);
  let data=[];
  try{const response=await fetch(`${OR}/models?output_modalities=all`,{headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`}});const body=await response.json();if(!response.ok)throw new Error('AI_FAILED');data=body.data||[];}catch{return(repo._aiCapabilities=out);}
  for(const [kind,id] of Object.entries(ids)){
    if(!id)continue;const model=data.find(x=>x.id===id);
    if(!model){out.models[kind]={id,known:false,structured:false};continue;}
    const input=model.architecture?.input_modalities||[],output=model.architecture?.output_modalities||[],parameters=model.supported_parameters||[];
    out.models[kind]={id,known:true,input_modalities:input,output_modalities:output,supported_parameters:parameters,structured:parameters.includes('structured_outputs')};
    if(kind==='text')out.text=input.includes('text');
    if(kind==='vision')out.vision=input.includes('image');
    if(kind==='audio')out.audio=input.includes('audio')||output.includes('transcription');
    if(kind==='file')out.file=input.includes('file');
  }
  const textModel=data.find(x=>x.id===ids.text);
  if(!out.vision&&textModel?.architecture?.input_modalities?.includes('image')){out.vision=true;out.models.vision={...out.models.text,id:ids.text,fallback:true};}
  if(!out.file&&textModel?.architecture?.input_modalities?.includes('file')){out.file=true;out.models.file={...out.models.text,id:ids.text,fallback:true};}
  return(repo._aiCapabilities=out);
}

async function chat(repo,env,{model,messages,jsonSchema=null,maxTokens=700}){
  if(!env.OPENROUTER_API_KEY||!model)throw new Error('AI_DISABLED');
  const caps=await getCapabilities(repo,env),cap=Object.values(caps.models).find(x=>x?.id===model),body={model,messages,max_completion_tokens:maxTokens,temperature:0.1};
  if(jsonSchema&&cap?.structured)body.response_format={type:'json_schema',json_schema:{name:'finance_response',strict:true,schema:jsonSchema}};
  const response=await fetch(`${OR}/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'content-type':'application/json','HTTP-Referer':env.PUBLIC_BASE_URL||'https://finance.local','X-Title':'Personal Finance Telegram'},body:JSON.stringify(body)});
  let result={};try{result=await response.json();}catch{}
  if(!response.ok||!result.choices?.[0]?.message)throw new Error('AI_FAILED');
  const content=result.choices[0].message.content;if(typeof content==='string')return content;
  if(Array.isArray(content))return content.map(x=>x?.text||'').join('\n');
  throw new Error('AI_FAILED');
}
function extractJson(text){
  const s=String(text||'').trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  try{return JSON.parse(s);}catch{const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)try{return JSON.parse(s.slice(a,b+1));}catch{}throw new Error('AI_INVALID_JSON');}
}
function isPlainObject(x){return !!x&&typeof x==='object'&&!Array.isArray(x);}
const plannerSchema={type:'object',additionalProperties:false,required:['kind'],properties:{kind:{type:'string',enum:['read','actions','split','clarify','chat']},read:{type:['object','null'],properties:{metric:{type:'string'},from:{type:'string'},to:{type:'string'},person_name:{type:'string'},merchant_name:{type:'string'},query:{type:'string'}},additionalProperties:true},actions:{type:'array',items:{type:'object',properties:{action:{type:'string'},data:{type:'object',additionalProperties:true}},required:['action','data'],additionalProperties:false}},split:{type:['object','null'],additionalProperties:true},question:{type:'string'},options:{type:'array',items:{type:'string'}},reply:{type:'string'}}};
function validatePlan(plan){
  if(!isPlainObject(plan)||!['read','actions','split','clarify','chat'].includes(plan.kind))throw new Error('AI_INVALID_JSON');
  if(plan.kind==='actions'){
    if(!Array.isArray(plan.actions)||plan.actions.length<1||plan.actions.length>20)throw new Error('AI_INVALID_JSON');
    for(const action of plan.actions)if(!isPlainObject(action)||!ALLOWED_ACTIONS.has(action.action)||!isPlainObject(action.data))throw new Error('AI_INVALID_JSON');
  }
  return plan;
}

async function resolveNamed(repo,sheet,name){
  if(!name)return{id:'',ambiguous:false};const field={People:'person_id',Merchants:'merchant_id',Projects:'project_id',Categories:'category_id',Accounts:'account_id',Installments:'installment_id'}[sheet],rows=await repo.list(sheet,{limit:5000,filter:x=>String(x.archived)!=='true'}),q=normalizeText(name);
  const exact=rows.filter(r=>normalizeText(r.name||r.title||'')===q);if(exact.length===1)return{id:exact[0][field],row:exact[0],ambiguous:false};if(exact.length>1)return{ambiguous:true,options:exact.slice(0,8).map(x=>({id:x[field],name:x.name||x.title}))};
  const partial=rows.filter(r=>normalizeText(r.name||r.title||'').includes(q)||q.includes(normalizeText(r.name||r.title||'')));if(partial.length===1)return{id:partial[0][field],row:partial[0],ambiguous:false};if(partial.length>1)return{ambiguous:true,options:partial.slice(0,8).map(x=>({id:x[field],name:x.name||x.title}))};return{id:'',ambiguous:false};
}
async function compactEntityContext(repo){
  const defs=[['Accounts','account_id','accounts'],['Categories','category_id','categories'],['People','person_id','people'],['Projects','project_id','projects'],['Merchants','merchant_id','merchants'],['Installments','installment_id','installments']];const out={};
  for(const [sheet,id,key] of defs){let rows=await repo.list(sheet,{limit:100,filter:x=>String(x.archived)!=='true'});if(sheet==='Installments')rows=rows.filter(x=>x.status!=='completed');out[key]=rows.slice(0,60).map(x=>({id:x[id],name:x.name||x.title||'',status:x.status||undefined}));}
  return out;
}
export async function planUserText(repo,env,text){
  const model=await modelId(repo,env,'text');if(!model)throw new Error('AI_DISABLED');const context=await compactEntityContext(repo);
  const prompt=`شما Planner مالی شخصی هستید. فقط JSON معتبر بده و هیچ write اجرا نکن.\nقواعد:\n- مبلغ تومان فقط عدد صحیح.\n- برای سؤال اطلاعاتی kind=read. برای ثبت یا ویرایش kind=actions. برای دنگ kind=split.\n- اگر کاربر شخص، قسط، حساب یا پروژه‌ای را نام برد که در context چند تطابق دارد، kind=clarify بده؛ حدس نزن.\n- برای شناسه‌ها فقط IDهای context را استفاده کن. اگر مورد جدید خواسته شد create_person/create_project مجاز است.\n- create_transaction type یکی از expense,income,transfer,installment_payment,debt,receivable,refund,adjustment.\n- هیچ delete یا bulk write پیشنهاد نده.\nmetricهای read: summary, top_expense, search, person, merchant.\nactionهای مجاز: create_transaction, edit_transaction, create_person, create_project, pay_installment, settle_debt.\ncontext: ${JSON.stringify(context)}\nمتن کاربر: ${text}`;
  const raw=await chat(repo,env,{model,messages:[{role:'system',content:'خروجی فقط JSON مطابق schema است.'},{role:'user',content:prompt}],jsonSchema:plannerSchema,maxTokens:1100});return validatePlan(extractJson(raw));
}

async function executeRead(repo,plan){
  const r=plan.read||{};let from=r.from,to=r.to;try{if(from)from=parseDateInput(from);if(to)to=parseDateInput(to);}catch{}
  if(r.metric==='person'){const person=await resolveNamed(repo,'People',r.person_name);if(person.ambiguous)return{clarify:'کدام شخص؟',options:person.options,entity:'person'};if(!person.id)return{data:{found:false,person:r.person_name}};return{data:await personSummary(repo,person.id),label:person.row.name};}
  if(r.metric==='merchant'){const merchant=await resolveNamed(repo,'Merchants',r.merchant_name);if(merchant.ambiguous)return{clarify:'کدام فروشنده؟',options:merchant.options,entity:'merchant'};const tx=await queryTransactions(repo,{from,to,merchant_id:merchant.id});return{data:{transactions:tx,summary:summarize(tx)},label:merchant.row?.name||r.merchant_name};}
  if(r.metric==='top_expense'){const tx=await queryTransactions(repo,{from,to}),item=tx.filter(t=>t.type==='expense'||t.type==='installment_payment').sort((a,b)=>Number(b.amount)-Number(a.amount))[0]||null;return{data:{transaction:item}};}
  if(r.metric==='search'){const tx=await queryTransactions(repo,{from,to,q:r.query});return{data:{count:tx.length,transactions:tx.slice(0,30)}};}
  return{data:await report(repo,{from,to})};
}
function deterministicReadText(result){
  if(result.clarify)return result.clarify;const d=result.data;
  if(d?.summary){const s=d.summary;return`خرج خالص ${Number(s.net_expense||0).toLocaleString('fa-IR')}، درآمد ${Number(s.income||0).toLocaleString('fa-IR')}، کارمزد ${Number(s.fees||0).toLocaleString('fa-IR')} تومان.`;}
  if(d?.transaction){const t=d.transaction;return t?`بیشترین مورد: ${t.description||'بدون شرح'} — ${Number(t.amount||0).toLocaleString('fa-IR')} تومان.`:'موردی پیدا نشد.';}
  if(d?.receivable!==undefined)return`طلب باز: ${Number(d.receivable).toLocaleString('fa-IR')}، بدهی باز: ${Number(d.debt).toLocaleString('fa-IR')} تومان.`;
  if(d?.count!==undefined)return`${d.count.toLocaleString('fa-IR')} مورد پیدا شد.`;return'اطلاعات پیدا شد.';
}
export async function handleAiText(repo,env,text){
  const plan=await planUserText(repo,env,text);
  if(plan.kind==='read'){
    const result=await executeRead(repo,plan);if(result.clarify)return{kind:'clarify',text:result.clarify,options:result.options,entity:result.entity||''};const base=deterministicReadText(result),model=await modelId(repo,env,'text');let friendly=base;
    try{const minimal=JSON.stringify(result.data,(key,value)=>key==='transactions'&&Array.isArray(value)?value.slice(0,12):value);friendly=await chat(repo,env,{model,messages:[{role:'system',content:'پاسخ فارسی کوتاه و بدون Markdown بده. اعداد داده‌شده را تغییر نده.'},{role:'user',content:`سؤال: ${text}\nنتیجه محاسبه قطعی کد: ${minimal}\nیک پاسخ کوتاه بنویس.`}],maxTokens:250});}catch{}
    return{kind:'read',text:sanitizeAiText(friendly),data:result.data};
  }
  if(plan.kind==='split'){try{return{kind:'split',result:calculateSplit(plan.split)}}catch{return{kind:'clarify',text:'اطلاعات دنگ کامل نیست؛ مبلغ کل، افراد و پرداختی هر نفر را مشخص کنید.'}}}
  if(plan.kind==='actions'){
    const proposal=await repo.insert('Drafts',{draft_id:uuid(),kind:'ai_actions',owner_telegram_id:String(env.OWNER_TELEGRAM_ID),state_json:json({text,actions:plan.actions}),status:'active',created_at:nowIso(),updated_at:nowIso(),expires_at:new Date(Date.now()+24*3600e3).toISOString(),schema_version:SCHEMA_VERSION});
    return{kind:'actions',draft_id:proposal.draft_id,actions:plan.actions};
  }
  return{kind:plan.kind,text:sanitizeAiText(plan.reply||plan.question||'لطفاً جزئیات بیشتری بگویید.'),options:plan.options||[]};
}

function requirePositiveInt(value){return Number.isSafeInteger(Number(value))&&Number(value)>0;}
export async function confirmAiActions(repo,finance,draftId){
  const draft=await repo.getById('Drafts',draftId);if(!draft||draft.kind!=='ai_actions'||draft.status!=='active')throw new Error('NOT_FOUND');const state=safeJsonParse(draft.state_json,{}),results=[];
  for(const action of state.actions||[]){
    if(!ALLOWED_ACTIONS.has(action.action)||!isPlainObject(action.data))throw new Error('AI_INVALID_ACTION');const x=action.data;
    if(action.action==='create_person'){
      if(!String(x.name||'').trim())throw new Error('VALIDATION');results.push(await repo.insert('People',{person_id:uuid(),name:String(x.name).trim(),phone:x.phone||'',note:x.note||'',color:x.color||'',favorite:false,archived:false,created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION}));
    }else if(action.action==='create_project'){
      if(!String(x.name||'').trim())throw new Error('VALIDATION');results.push(await repo.insert('Projects',{project_id:uuid(),name:String(x.name).trim(),description:x.description||'',icon:x.icon||'',color:x.color||'',budget:x.budget||'',start_date:x.start_date||'',end_date:x.end_date||'',status:'active',archived:false,created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION}));
    }else if(action.action==='create_transaction'){
      if(!requirePositiveInt(x.amount))throw new Error('VALIDATION');
      if(x.type==='receivable')results.push(await finance.createReceivable({...x,date:x.transaction_date||x.transaction_date_iso,source:'ai'}));
      else if(x.type==='debt')results.push(await finance.createDebt({...x,date:x.transaction_date||x.transaction_date_iso,source:'ai'}));
      else results.push(await finance.createTransaction(x,'ai'));
    }else if(action.action==='edit_transaction'){
      if(!x.transaction_id||!isPlainObject(x.patch))throw new Error('VALIDATION');results.push(await finance.editTransaction(x.transaction_id,x.patch));
    }else if(action.action==='pay_installment'){
      if(!x.installment_id)throw new Error('VALIDATION');results.push(await finance.payInstallment(x.installment_id,{...x,source:'ai'}));
    }else if(action.action==='settle_debt'){
      if(!x.debt_id)throw new Error('VALIDATION');results.push(await finance.settleDebt(x.debt_id,{...x,source:'ai'}));
    }
  }
  await repo.updateById('Drafts',draftId,{status:'confirmed'},{action:'ai_confirm'});await repo.audit('Drafts',draftId,'AI-write',draft,{...draft,status:'confirmed'});return results;
}
export function sanitizeAiText(value=''){return String(value).replace(/```[\s\S]*?```/g,'').replace(/\*\*|__|###?|`/g,'').replace(/\n{3,}/g,'\n\n').trim().slice(0,3500);}
function bytesToB64(bytes){let s='';const u=new Uint8Array(bytes);for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode(...u.subarray(i,i+0x8000));return btoa(s);}

export async function extractReceipt(repo,env,bytes,mime='image/webp'){
  const caps=await getCapabilities(repo,env);if(!caps.vision)throw new Error('AI_DISABLED');const model=caps.models.vision.id,dataUrl=`data:${mime};base64,${bytesToB64(bytes)}`;
  const schema={type:'object',additionalProperties:false,properties:{amount:{type:['integer','null']},date:{type:['string','null']},merchant:{type:['string','null']},fee:{type:['integer','null']},tracking_number:{type:['string','null']},reference_number:{type:['string','null']},description:{type:['string','null']}},required:['amount','date','merchant','fee','tracking_number','reference_number','description']};
  const raw=await chat(repo,env,{model,messages:[{role:'system',content:'از تصویر رسید فقط داده‌های قابل مشاهده را استخراج کن. حدس نزن. مبلغ تومان عدد صحیح.'},{role:'user',content:[{type:'text',text:'اطلاعات رسید را JSON استخراج کن.'},{type:'image_url',image_url:{url:dataUrl}}]}],jsonSchema:schema,maxTokens:400}),x=extractJson(raw);
  if(x.amount!==null&&!Number.isSafeInteger(x.amount))throw new Error('AI_INVALID_JSON');if(x.fee!==null&&!Number.isSafeInteger(x.fee))throw new Error('AI_INVALID_JSON');return x;
}
export async function transcribeAudio(repo,env,bytes,format='ogg'){
  const caps=await getCapabilities(repo,env),model=await modelId(repo,env,'audio');if(!caps.audio||!model||!env.OPENROUTER_API_KEY)throw new Error('AI_DISABLED');
  const response=await fetch(`${OR}/audio/transcriptions`,{method:'POST',headers:{authorization:`Bearer ${env.OPENROUTER_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({input_audio:{data:bytesToB64(bytes),format},model,language:'fa'})});let result={};try{result=await response.json();}catch{}if(!response.ok||!result.text)throw new Error('AI_FAILED');return result.text;
}
const bankRowsSchema={type:'object',additionalProperties:false,required:['rows'],properties:{rows:{type:'array',items:{type:'object',additionalProperties:false,required:['date','amount','description','tracking_number','reference_number','bank_transaction_id','type'],properties:{date:{type:'string'},amount:{type:'integer'},description:{type:'string'},tracking_number:{type:'string'},reference_number:{type:'string'},bank_transaction_id:{type:'string'},type:{type:'string'}}}}}};
export async function analyzePdf(repo,env,bytes,fileName='statement.pdf'){
  const caps=await getCapabilities(repo,env),model=caps.file?caps.models.file.id:'';if(!model||!env.OPENROUTER_API_KEY)throw new Error('AI_DISABLED');const data=`data:application/pdf;base64,${bytesToB64(bytes)}`;
  const raw=await chat(repo,env,{model,messages:[{role:'system',content:'ردیف‌های بانکی قابل مشاهده را بدون حدس استخراج کن. amount تومان عدد صحیح مثبت باشد. type فقط expense,income,transfer,refund. اگر مقدار وجود ندارد رشته خالی بده.'},{role:'user',content:[{type:'text',text:'صورتحساب بانکی را به rows استاندارد تبدیل کن.'},{type:'file',file:{filename:fileName,file_data:data}}]}],jsonSchema:bankRowsSchema,maxTokens:1800}),parsed=extractJson(raw);
  if(!Array.isArray(parsed.rows))throw new Error('AI_INVALID_JSON');for(const row of parsed.rows){if(!Number.isSafeInteger(row.amount)||row.amount<=0)throw new Error('AI_INVALID_JSON');if(!['expense','income','transfer','refund'].includes(row.type))row.type='expense';}return parsed;
}
