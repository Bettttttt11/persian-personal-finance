import { Repository } from './repository.js';
import { migrate, SHEETS, ID_FIELD } from './schema.js';
import { authenticateMiniApi, loginMiniApp, miniAuthConfig, pinStatus, revokeSession } from './auth.js';
import { FinanceService, ENTITY_MAP, calculateSplit } from './business.js';
import { dashboard, report, comparePeriods, queryTransactions, personSummary, projectSummary } from './reports.js';
import { previewImport, confirmImport } from './imports.js';
import { createBackup, previewRestore, applyRestore } from './backup.js';
import { undoLast } from './audit.js';
import { getCapabilities, handleAiText, confirmAiActions, removeAiAction, reviseAiActions, getAiDraft, extractReceipt, analyzePdf } from './ai.js';
import { saveReceipt, replaceWithWebp, getPrivate, putPrivate, deleteReceipt, saveInboxFile, storageStats, hasR2, probePrivateStorage, storageKind } from './storage.js';
import { telegramCall, telegramSendDocument } from './telegram-api.js';
import { DEFAULT_CURRENCY, SCHEMA_VERSION, bad, bool, clearCookie as clearCookieUtil, corsHeaders, currencyCode, fromRial, nowIso, ok, safeJsonParse, securityHeaders, toCsv, toRial, userError, uuid } from './utils.js';
import { jalaliMonthRangeOffset, parseDateInput } from './jalali.js';

const ENTITY_ALLOWED=new Set(Object.keys(ENTITY_MAP));
const ALLOWED_SETTINGS=new Set(['session_timeout','keep_original_receipts','receipt_quality','receipt_max_side','budget_thresholds','default_account','default_currency','reminder_preferences','openrouter_text_model','openrouter_vision_model','openrouter_audio_model','openrouter_file_model','export_retention_hours','manual_transaction_date','manual_transaction_time']);

function base(env,request){return env.PUBLIC_BASE_URL||new URL(request.url).origin;}
function withCors(response,request,env){const headers=new Headers(response.headers);for(const [key,value] of Object.entries(corsHeaders(request,base(env,request))))headers.set(key,value);return new Response(response.body,{status:response.status,statusText:response.statusText,headers});}
function payloadError(error){const status=error.message==='UNAUTHORIZED'?401:error.message==='NOT_FOUND'?404:error.message==='PIN_LOCKED'?429:['IMPORT_REVIEW_REQUIRED','ENTITY_IN_USE'].includes(error.message)?409:400,message=error.message==='AI_NEEDS_CLARIFICATION'&&error.detail?String(error.detail).slice(0,300):userError(error);return bad(message,status,error.message||'ERROR');}
async function bodyJson(request){try{return await request.json();}catch{throw new Error('VALIDATION');}}
function cleanForClient(row){if(!row)return row;const out={...row};delete out.__row;delete out.token_hash;return out;}
function cleanDeep(value){if(Array.isArray(value))return value.map(cleanDeep);if(value&&typeof value==='object'){const out={};for(const [key,item] of Object.entries(value)){if(key==='__row'||key==='token_hash')continue;out[key]=cleanDeep(item);}return out;}return value;}
function paginate(url){return{limit:Math.max(1,Math.min(200,Number(url.searchParams.get('limit')||50))),offset:Math.max(0,Number(url.searchParams.get('offset')||0))};}
function filtersFrom(url){
  const keys=['from','to','type','account_id','destination_account_id','category_id','person_id','project_id','merchant_id','tag_id','installment_id','source','status','q','time_from','time_to'],filters={};
  for(const key of keys){const value=url.searchParams.get(key);if(value)filters[key]=value;}
  for(const key of ['min_amount','max_amount','min_fee','max_fee']){const value=url.searchParams.get(key);if(value!==null&&value!=='')filters[key]=Number(value);}
  for(const key of ['has_fee','has_receipt','starred','installment','debt_receivable'])if(url.searchParams.has(key))filters[key]=url.searchParams.get(key)==='true';
  return filters;
}
function validateConfig(env){
  const required=['TELEGRAM_BOT_TOKEN','OWNER_TELEGRAM_ID','SPREADSHEET_ID','GOOGLE_SERVICE_ACCOUNT_JSON','SESSION_SECRET'],missing=required.filter(key=>!env[key]);
  const checks={required_secrets:{ok:missing.length===0,missing},session_secret:{ok:!!env.SESSION_SECRET&&String(env.SESSION_SECRET).length>=24},storage:{configured:hasR2(env),kind:storageKind(env)},openrouter:{configured:!!env.OPENROUTER_API_KEY},public_base_url:{configured:!!env.PUBLIC_BASE_URL}};
  return checks;
}
async function createFinancial(finance,body,source){
  if(body.type==='receivable')return finance.createReceivable({...body,date:body.transaction_date||body.transaction_date_iso,source});
  if(body.type==='debt')return finance.createDebt({...body,date:body.transaction_date||body.transaction_date_iso,source});
  if(body.type==='installment_payment'&&body.installment_id)return finance.payInstallment(body.installment_id,{...body,date:body.transaction_date||body.transaction_date_iso,source});
  return finance.createTransaction(body,source);
}

export async function handleApi(request,env){
  if(request.method==='OPTIONS')return withCors(new Response(null,{status:204,headers:securityHeaders()}),request,env);
  const url=new URL(request.url),path=url.pathname,repo=new Repository(env,'mini_app');
  try{
    if(path==='/api/auth/config'&&request.method==='POST')return withCors(ok({data:await miniAuthConfig(request,repo,env)}),request,env);
    if(path==='/api/auth/login'&&request.method==='POST'){
      const login=await loginMiniApp(request,repo,env),response=ok({user:{id:login.user.id,first_name:login.user.first_name||''}});response.headers.append('set-cookie',login.cookie);return withCors(response,request,env);
    }
    const auth=await authenticateMiniApi(request,repo,env);
    if(request.method==='GET'&&path==='/api/dashboard')await repo.prefetch(['Transactions','Accounts','Categories','People','Projects','Merchants','Tags','Installments','Debts','Inbox','Budgets','Settings']);
    else if(request.method==='GET'&&path==='/api/lookups')await repo.prefetch(['Accounts','Categories','People','Projects','Tags','Merchants','Installments']);
    else if(request.method==='GET'&&path==='/api/reports')await repo.prefetch(['Transactions','Accounts','Categories','People','Projects','Merchants','Tags','EntityTags']);
    else if(request.method==='GET'&&path==='/api/transactions'){const names=['Transactions'];if(url.searchParams.get('tag_id')||url.searchParams.get('q'))names.push('EntityTags','Tags');if(url.searchParams.get('q'))names.push('Accounts','Categories','People','Projects','Merchants');await repo.prefetch(names);}
    const finance=new FinanceService(repo,'owner');
    if(path==='/api/auth/logout'&&request.method==='POST'){
      await revokeSession(repo,auth.session.session_id);const response=ok();response.headers.append('set-cookie',clearCookieUtil('pf_session'));return withCors(response,request,env);
    }
    let result;

    if(path==='/api/admin/setup'&&request.method==='POST')result={config:validateConfig(env),migration:await migrate(repo),health:await health(repo,env)};
    else if(path==='/api/admin/telegram-webhook'&&request.method==='GET')result=await telegramCall(env,'getWebhookInfo',{});
    else if(path==='/api/admin/telegram-webhook'&&request.method==='POST'){const webhookUrl=`${base(env,request).replace(/\/$/,'')}/telegram`,payload={url:webhookUrl,allowed_updates:['message','callback_query']};if(env.TELEGRAM_WEBHOOK_SECRET)payload.secret_token=env.TELEGRAM_WEBHOOK_SECRET;result=await telegramCall(env,'setWebhook',payload);}
    else if(path==='/api/health'&&request.method==='GET')result=await health(repo,env);
    else if(path==='/api/dashboard'&&request.method==='GET')result=await dashboard(repo,finance);
    else if(path==='/api/lookups'&&request.method==='GET')result=await lookupBundle(repo);

    else if(path==='/api/transactions'&&request.method==='GET'){
      const page=paginate(url),all=await queryTransactions(repo,filtersFrom(url));result={items:all.slice(page.offset,page.offset+page.limit).map(cleanForClient),total:all.length,...page};
    }else if(path==='/api/transactions'&&request.method==='POST'){
      const body=await bodyJson(request),key=request.headers.get('x-idempotency-key')||uuid();result=await repo.idempotent(key,'api:create_tx',()=>createFinancial(finance,body,'mini_app'));
    }else if(/^\/api\/transactions\/[^/]+$/.test(path)){
      const id=path.split('/')[3];
      if(request.method==='GET')result=await txDetail(repo,id);
      else if(request.method==='PATCH')result=await finance.editTransaction(id,await bodyJson(request));
      else if(request.method==='DELETE'){
        if(url.searchParams.get('permanent')==='true'){if(request.headers.get('x-confirm-permanent-delete')!==`DELETE ${id}`)throw new Error('VALIDATION');result={deleted:await repo.permanentDelete('Transactions',id)};}
        else result=await finance.softDeleteTransaction(id);
      }
    }else if(/^\/api\/transactions\/[^/]+\/restore$/.test(path)&&request.method==='POST')result=await finance.restoreTransaction(path.split('/')[3]);
    else if(/^\/api\/transactions\/[^/]+\/tags$/.test(path)&&request.method==='PUT')result=await replaceTransactionTags(repo,path.split('/')[3],(await bodyJson(request)).tag_ids||[]);

    else if(path==='/api/search'&&request.method==='GET'){
      const all=await queryTransactions(repo,{q:url.searchParams.get('q')||''});result={items:all.slice(0,100).map(cleanForClient),total:all.length};
    }else if(path==='/api/calendar/month'&&request.method==='GET')result=jalaliMonthRangeOffset(Math.max(-240,Math.min(0,Number(url.searchParams.get('offset')||0))));
    else if(path==='/api/reports'&&request.method==='GET')result=await report(repo,filtersFrom(url));
    else if(path==='/api/reports/compare'&&request.method==='GET'){
      const common=filtersFrom(url);delete common.from;delete common.to;result=await comparePeriods(repo,{...common,from:url.searchParams.get('from')||'',to:url.searchParams.get('to')||''},{...common,from:url.searchParams.get('previous_from')||'',to:url.searchParams.get('previous_to')||''});
    }
    else if(path==='/api/accounts/balances'&&request.method==='GET'){
      const rows=await repo.list('Accounts',{limit:1000,includeDeleted:false}),balances=await finance.accountBalances(rows.map(x=>x.account_id));result={items:rows.map(account=>({...cleanForClient(account),balance:Number(balances[account.account_id]||0)}))};
    }else if(/^\/api\/accounts\/[^/]+\/transactions$/.test(path)&&request.method==='GET'){
      const id=path.split('/')[3],all=await queryTransactions(repo,{}),items=all.filter(x=>x.account_id===id||x.destination_account_id===id);result={items:items.slice(0,200).map(cleanForClient),total:items.length};
    }else if(/^\/api\/people\/[^/]+\/summary$/.test(path)&&request.method==='GET')result=await personSummary(repo,path.split('/')[3]);
    else if(/^\/api\/projects\/[^/]+\/summary$/.test(path)&&request.method==='GET')result=await projectSummary(repo,path.split('/')[3]);
    else if(/^\/api\/installments\/[^/]+\/summary$/.test(path)&&request.method==='GET')result=await finance.installmentSummary(path.split('/')[3]);
    else if(/^\/api\/installments\/[^/]+\/pay$/.test(path)&&request.method==='POST')result=await finance.payInstallment(path.split('/')[3],{...(await bodyJson(request)),source:'mini_app'});
    else if(/^\/api\/installments\/[^/]+\/restore$/.test(path)&&request.method==='POST')result=await finance.restoreInstallment(path.split('/')[3]);
    else if(/^\/api\/installments\/[^/]+$/.test(path)&&request.method==='DELETE')result=await finance.softDeleteInstallment(path.split('/')[3]);
    else if(/^\/api\/debts\/[^/]+\/settle$/.test(path)&&request.method==='POST')result=await finance.settleDebt(path.split('/')[3],{...(await bodyJson(request)),source:'mini_app'});

    else if(path==='/api/undo'&&request.method==='POST')result=await undoLast(repo,finance);
    else if(path==='/api/changelog'&&request.method==='GET'){
      const page=paginate(url),rows=await repo.list('ChangeLog',{limit:10000,sort:(a,b)=>String(b.created_at).localeCompare(String(a.created_at))});result={items:rows.slice(page.offset,page.offset+page.limit).map(cleanForClient),total:rows.length,...page};
    }else if(path==='/api/links'&&request.method==='GET'){
      const entityId=url.searchParams.get('entity_id')||'',rows=await repo.list('Links',{limit:5000,filter:x=>!entityId||x.from_id===entityId||x.to_id===entityId});result={items:rows.map(cleanForClient)};
    }

    else if(path==='/api/inbox'&&request.method==='GET'){
      const page=paginate(url),status=url.searchParams.get('status'),rows=await repo.list('Inbox',{limit:5000,filter:x=>!status||x.status===status,sort:(a,b)=>String(b.created_at).localeCompare(String(a.created_at))});result={items:rows.slice(page.offset,page.offset+page.limit).map(cleanForClient),total:rows.length};
    }else if(/^\/api\/inbox\/[^/]+$/.test(path)&&request.method==='PATCH')result=await repo.updateById('Inbox',path.split('/')[3],await bodyJson(request));

    else if(path==='/api/drafts'&&request.method==='GET'){
      const kind=url.searchParams.get('kind'),rows=await repo.list('Drafts',{limit:1000,filter:x=>x.status==='active'&&(!x.expires_at||x.expires_at>nowIso())&&(!kind||x.kind===kind)});result={items:rows.map(cleanForClient)};
    }else if(path==='/api/drafts'&&request.method==='POST'){
      const body=await bodyJson(request),old=body.draft_id?await repo.getById('Drafts',body.draft_id):null;
      if(old)result=await repo.updateById('Drafts',body.draft_id,{state_json:JSON.stringify(body.state||{}),updated_at:nowIso()},{audit:false});
      else result=await repo.insert('Drafts',{draft_id:uuid(),kind:body.kind||'mini_tx',owner_telegram_id:String(env.OWNER_TELEGRAM_ID),state_json:JSON.stringify(body.state||{}),status:'active',created_at:nowIso(),updated_at:nowIso(),expires_at:new Date(Date.now()+7*864e5).toISOString(),schema_version:SCHEMA_VERSION},{audit:false});
    }else if(/^\/api\/drafts\/[^/]+$/.test(path)&&request.method==='DELETE')result=await repo.updateById('Drafts',path.split('/')[3],{status:'discarded'},{audit:false});

    else if(path==='/api/settings'&&request.method==='GET')result=await publicSettings(repo,env);
    else if(path==='/api/settings'&&request.method==='PATCH'){
      const body=await bodyJson(request);for(const [key,value] of Object.entries(body)){if(!ALLOWED_SETTINGS.has(key))continue;validateSetting(key,value);await repo.setSetting(key,value);}result=await publicSettings(repo,env);
    }else if(path==='/api/storage'&&request.method==='GET')result={...(await storageStats(repo,env)),schema_version:SCHEMA_VERSION,last_backup:await repo.setting('last_backup','')};

    else if(path==='/api/backup'&&request.method==='GET'){
      const backup=await createBackup(repo);await repo.setSetting('last_backup',nowIso());return withCors(new Response(JSON.stringify(backup,null,2),{headers:{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename="finance-backup-${new Date().toISOString().slice(0,10)}.json"`,...securityHeaders()}}),request,env);
    }else if(path==='/api/restore/preview'&&request.method==='POST')result=await previewRestore(repo,await bodyJson(request));
    else if(path==='/api/restore/apply'&&request.method==='POST'){
      const body=await bodyJson(request);if(body.confirm!=='RESTORE')throw new Error('VALIDATION');result=await applyRestore(repo,body.backup,{overwrite:!!body.overwrite});
    }else if(/^\/api\/restore\/receipts\/[^/]+$/.test(path)&&request.method==='POST')result=await restoreReceiptFiles(request,repo,env,path.split('/')[4]);

    else if(path==='/api/export/csv'&&request.method==='GET'){
      const filters=filtersFrom(url),rep=await report(repo,filters),displayCurrency=currencyCode(url.searchParams.get('display_currency')||await repo.setting('default_currency',DEFAULT_CURRENCY)),csv=await completeReportCsv(repo,rep,displayCurrency);return withCors(new Response(csv,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="finance-report.csv"',...securityHeaders()}}),request,env);
    }else if(path==='/api/telegram/send-document'&&request.method==='POST'){
      const form=await request.formData(),file=form.get('file');if(!(file instanceof File)||file.size<=0||file.size>45*1024*1024)throw new Error('VALIDATION');const caption=String(form.get('caption')||''),message=await telegramSendDocument(env,env.OWNER_TELEGRAM_ID,await file.arrayBuffer(),{filename:file.name||'finance-export.bin',mime:file.type||'application/octet-stream',caption}),retention=Math.max(1,Math.min(20,Number(await repo.setting('export_retention_hours',12)||12)));
      await repo.insert('Drafts',{draft_id:uuid(),kind:'export_cleanup',owner_telegram_id:String(env.OWNER_TELEGRAM_ID),state_json:JSON.stringify({chat_id:String(env.OWNER_TELEGRAM_ID),message_id:message.message_id,file_name:file.name||'finance-export.bin'}),status:'active',created_at:nowIso(),updated_at:nowIso(),expires_at:new Date(Date.now()+retention*3600e3).toISOString(),schema_version:SCHEMA_VERSION},{audit:false});
      result={sent:true,message,cleanup_hours:retention};
    }

    else if(path==='/api/receipts'&&request.method==='POST')result=await uploadReceipt(request,repo,env);
    else if(/^\/api\/receipts\/[^/]+\/optimize$/.test(path)&&request.method==='POST')result=await optimizeReceipt(request,repo,env,path.split('/')[3]);
    else if(/^\/api\/receipts\/[^/]+\/ai$/.test(path)&&request.method==='POST')result=await receiptAi(repo,env,path.split('/')[3]);
    else if(/^\/api\/receipts\/[^/]+\/ai-confirm$/.test(path)&&request.method==='POST')result=await confirmReceiptAi(repo,finance,path.split('/')[3],await bodyJson(request));
    else if(/^\/api\/receipts\/[^/]+$/.test(path)){
      const id=path.split('/')[3];if(request.method==='GET')return withCors(await receiptResponse(repo,env,id,url.searchParams.get('thumb')==='true'?'thumb':url.searchParams.get('original')==='true'?'original':'main',url.searchParams.get('download')==='true'),request,env);if(request.method==='DELETE')result={deleted:await deleteReceipt(repo,env,id)};
    }

    else if(path==='/api/imports/file'&&request.method==='POST')result=await uploadImportFile(request,repo,env);
    else if(path==='/api/imports/preview'&&request.method==='POST'){
      const body=await bodyJson(request),key=request.headers.get('x-idempotency-key');result=key?await repo.idempotent(key,'api:import_preview',()=>previewImport(repo,body)):await previewImport(repo,body);
    }else if(path==='/api/imports'&&request.method==='GET'){
      const rows=await repo.list('Imports',{limit:2000,sort:(a,b)=>String(b.created_at).localeCompare(String(a.created_at))});result={items:rows.map(cleanForClient)};
    }else if(/^\/api\/imports\/[^/]+\/items$/.test(path)&&request.method==='GET'){
      const id=path.split('/')[3],rows=await repo.list('ImportItems',{limit:20000,filter:x=>x.import_id===id});result={items:rows.map(cleanForClient)};
    }else if(/^\/api\/imports\/[^/]+\/file$/.test(path)&&request.method==='GET')return withCors(await importFileResponse(repo,env,path.split('/')[3]),request,env);
    else if(/^\/api\/imports\/[^/]+\/confirm$/.test(path)&&request.method==='POST')result=await confirmImport(repo,finance,path.split('/')[3],(await bodyJson(request)).decisions||{});

    else if(path==='/api/ai/capabilities'&&request.method==='GET')result=await getCapabilities(repo,env);
    else if(path==='/api/ai/ask'&&request.method==='POST'){const body=await bodyJson(request);result=await handleAiText(repo,env,body.text||'',Array.isArray(body.history)?body.history:[]);}
    else if(/^\/api\/ai\/draft\/[^/]+$/.test(path)&&request.method==='GET'){const d=await getAiDraft(repo,path.split('/')[4]);result={draft_id:d.draft.draft_id,status:d.draft.status,actions:d.actions};}
    else if(/^\/api\/ai\/confirm\/[^/]+$/.test(path)&&request.method==='POST')result={items:await confirmAiActions(repo,finance,path.split('/')[4])};
    else if(/^\/api\/ai\/remove\/[^/]+\/\d+$/.test(path)&&request.method==='POST'){const parts=path.split('/');result=await removeAiAction(repo,parts[4],Number(parts[5]));}
    else if(/^\/api\/ai\/revise\/[^/]+$/.test(path)&&request.method==='POST'){const body=await bodyJson(request);result=await reviseAiActions(repo,env,path.split('/')[4],body.instruction||'',Array.isArray(body.history)?body.history:[]);}
    else if(/^\/api\/ai\/cancel\/[^/]+$/.test(path)&&request.method==='POST')result=await repo.updateById('Drafts',path.split('/')[4],{status:'discarded'},{action:'ai_cancel'});
    else if(path==='/api/ai/pdf'&&request.method==='POST'){
      const form=await request.formData(),file=form.get('file');if(!(file instanceof File))throw new Error('VALIDATION');result=await analyzePdf(repo,env,await file.arrayBuffer(),file.name);
    }

    else if(path==='/api/splits/calculate'&&request.method==='POST'){const body=await bodyJson(request),cur=body.input_currency||body.currency||await repo.setting('default_currency',DEFAULT_CURRENCY);result=calculateSplit(normalizeSplitMoney(body,cur));}
    else if(path==='/api/splits'&&request.method==='POST'){const body=await bodyJson(request),cur=body.input_currency||body.currency||await repo.setting('default_currency',DEFAULT_CURRENCY);result=await saveSplit(repo,normalizeSplitMoney(body,cur));}
    else if(/^\/api\/splits\/[^/]+\/receivables$/.test(path)&&request.method==='POST')result=await splitToReceivables(repo,finance,path.split('/')[3],await bodyJson(request));

    else if(path==='/api/trash'&&request.method==='GET')result=await trashItems(repo);
    else if(/^\/api\/merge\/[^/]+$/.test(path)&&request.method==='POST'){
      const name=path.split('/')[3],sheet=ENTITY_MAP[name];if(!sheet)throw new Error('VALIDATION');const body=await bodyJson(request);if(body.confirm!=='MERGE')throw new Error('VALIDATION');result=await finance.merge(sheet,body.primary_id,body.duplicate_id);
    }else{
      const generic=await genericEntity(path,request,repo,url);if(generic.handled)result=generic.result;else return withCors(bad('مسیر پیدا نشد.',404,'NOT_FOUND'),request,env);
    }
    return withCors(ok({data:cleanDeep(result)}),request,env);
  }catch(error){return withCors(payloadError(error),request,env);}
}

function validateSetting(key,value){
  if(key==='session_timeout'&&!['15m','30m','1h','manual'].includes(value))throw new Error('VALIDATION');
  if(key==='receipt_quality'&&(!Number.isInteger(Number(value))||Number(value)<40||Number(value)>95))throw new Error('VALIDATION');
  if(key==='receipt_max_side'&&(!Number.isInteger(Number(value))||Number(value)<600||Number(value)>2400))throw new Error('VALIDATION');
  if(key==='export_retention_hours'&&(!Number.isInteger(Number(value))||Number(value)<1||Number(value)>20))throw new Error('VALIDATION');
  if(key==='keep_original_receipts'&&typeof value!=='boolean')throw new Error('VALIDATION');
  if((key==='manual_transaction_date'||key==='manual_transaction_time')&&typeof value!=='boolean')throw new Error('VALIDATION');
  if(key==='default_currency'&&!['IRR','TOMAN'].includes(String(value||'').toUpperCase()))throw new Error('VALIDATION');
  if(key==='budget_thresholds'){
    if(!Array.isArray(value)||!value.length||value.some(x=>!Number.isFinite(Number(x))||Number(x)<=0||Number(x)>100))throw new Error('VALIDATION');
    const normalized=[...new Set(value.map(Number))].sort((a,b)=>a-b);if(normalized.length!==value.length)throw new Error('VALIDATION');
  }
  if(key==='reminder_preferences'){
    if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('VALIDATION');
    const allowed=new Set(['recurring','installments','debts','budgets']);for(const [k,v] of Object.entries(value))if(!allowed.has(k)||typeof v!=='boolean')throw new Error('VALIDATION');
  }
  if(key.startsWith('openrouter_')&&key.endsWith('_model')&&value!==null&&typeof value!=='string')throw new Error('VALIDATION');
  if(key==='default_account'&&value!==null&&typeof value!=='string')throw new Error('VALIDATION');
}
async function publicSettings(repo,env){const out={};for(const key of ALLOWED_SETTINGS)out[key]=await repo.setting(key,key==='default_currency'?DEFAULT_CURRENCY:null);out.storage_currency=await repo.setting('storage_currency','IRR');out.storage_configured=hasR2(env);out.storage_kind=storageKind(env);out.r2_configured=hasR2(env);out.openrouter_configured=!!env.OPENROUTER_API_KEY;out.pin=await pinStatus(repo,env);return out;}
const ENTITY_MONEY_FIELDS={Accounts:['opening_balance'],Projects:['budget'],Installments:['total_amount','default_installment_amount'],Recurring:['amount'],Budgets:['amount'],Debts:['principal_amount','settled_amount']};
function normalizeEntityMoney(sheet,row,inputCurrency=DEFAULT_CURRENCY){for(const key of ENTITY_MONEY_FIELDS[sheet]||[]){if(row[key]===undefined||row[key]==='')continue;const n=Number(row[key]);if(!Number.isSafeInteger(n)||n<0)throw new Error('INVALID_MONEY');row[key]=toRial(n,inputCurrency);}return row;}
function normalizeSplitMoney(body,inputCurrency=DEFAULT_CURRENCY){const currency=currencyCode(inputCurrency),out={...body,total_amount:toRial(Number(body.total_amount||0),currency)};out.items=(body.items||[]).map(x=>({...x,paid_amount:toRial(Number(x.paid_amount||0),currency),share_value:body.mode==='custom'?toRial(Number(x.share_value||0),currency):x.share_value}));return out;}
function validateEntityInput(sheet,row){
  const moneyFields={Accounts:['opening_balance'],Projects:['budget'],Installments:['total_amount','default_installment_amount'],Recurring:['amount'],Budgets:['amount'],Debts:['principal_amount','settled_amount']}[sheet]||[];
  for(const key of moneyFields)if(row[key]!==undefined&&row[key]!==''){const n=Number(row[key]);if(!Number.isSafeInteger(n)||n<0)throw new Error('INVALID_MONEY');row[key]=n;}
  const positiveInts={Installments:['installment_count','due_day'],Rules:['priority']}[sheet]||[];for(const key of positiveInts)if(row[key]!==undefined&&row[key]!==''){const n=Number(row[key]);if(!Number.isInteger(n)||(key==='priority'?n<0:n<=0)||(key==='due_day'&&n>31))throw new Error('VALIDATION');row[key]=n;}
  const dateFields={Projects:['start_date','end_date'],Installments:['start_date'],Recurring:['next_due_date'],Debts:['due_date']}[sheet]||[];for(const key of dateFields)if(row[key])row[key]=parseDateInput(row[key]);
  if(sheet==='Installments'&&row.due_dates_json!==undefined&&row.due_dates_json!==''){let dates;try{dates=typeof row.due_dates_json==='string'?JSON.parse(row.due_dates_json):row.due_dates_json}catch{throw new Error('VALIDATION')}if(!Array.isArray(dates)||dates.some(x=>!String(x||'').trim()))throw new Error('VALIDATION');dates=dates.map(parseDateInput);if(row.installment_count!==undefined&&Number(row.installment_count)!==dates.length)throw new Error('VALIDATION');row.due_dates_json=JSON.stringify(dates);}
  const enums={Accounts:{type:['Bank account','Card','Cash','Wallet','Other']},Categories:{type:['expense','income','both']},Projects:{status:['active','completed','archived']},Installments:{status:['active','completed','overdue']},Recurring:{type:['expense','income'],frequency:['daily','weekly','monthly','yearly','custom']},Budgets:{scope_type:['global','category','project']},Templates:{type:['expense','income','transfer']}}[sheet]||{};for(const [key,values] of Object.entries(enums))if(row[key]!==undefined&&row[key]!==''&&!values.includes(String(row[key])))throw new Error('VALIDATION');
  const jsonFields={Merchants:['default_tags_json'],Rules:['conditions_json','actions_json'],Templates:['tags_json'],Recurring:['custom_json'],Budgets:['warning_thresholds_json']}[sheet]||[];for(const key of jsonFields)if(row[key]!==undefined&&row[key]!==''){let parsed;try{parsed=typeof row[key]==='string'?JSON.parse(row[key]):row[key]}catch{throw new Error('VALIDATION')}if(['default_tags_json','tags_json','warning_thresholds_json'].includes(key)&&!Array.isArray(parsed))throw new Error('VALIDATION');if(['conditions_json','actions_json','custom_json'].includes(key)&&(parsed===null||Array.isArray(parsed)||typeof parsed!=='object'))throw new Error('VALIDATION');row[key]=JSON.stringify(parsed);}
  if(sheet==='Installments'&&row.total_amount!==undefined&&row.default_installment_amount!==undefined&&Number(row.default_installment_amount)>Number(row.total_amount))throw new Error('VALIDATION');return row;
}
function entityDefaults(sheet,row){
  if(['Accounts','Categories','People','Projects','Tags','Merchants','Templates'].includes(sheet)){if(row.archived===undefined)row.archived=false;if(row.favorite===undefined)row.favorite=false;}
  if(SHEETS[sheet]?.includes('is_deleted')&&row.is_deleted===undefined)row.is_deleted=false;if(SHEETS[sheet]?.includes('deleted_at')&&row.deleted_at===undefined)row.deleted_at='';
  if(sheet==='Projects'&&!row.status)row.status='active';if(sheet==='Installments'&&!row.status)row.status='active';if(sheet==='Rules'&&row.enabled===undefined)row.enabled=true;if(sheet==='Recurring'&&row.enabled===undefined)row.enabled=true;if(sheet==='Budgets'&&row.active===undefined)row.active=true;return row;
}
async function genericEntity(path,request,repo,url){
  const match=path.match(/^\/api\/entities\/([^/]+)(?:\/([^/]+))?(?:\/(archive|restore|undelete))?$/);if(!match||!ENTITY_ALLOWED.has(match[1]))return{handled:false};
  const name=match[1],sheet=ENTITY_MAP[name],id=match[2],action=match[3],idField=ID_FIELD[sheet];
  if(request.method==='GET'&&!id){const page=paginate(url),rows=await repo.list(sheet,{limit:5000,filter:x=>!bool(x.is_deleted)&&(url.searchParams.get('archived')==='all'||!bool(x.archived)),sort:(a,b)=>Number(bool(b.favorite))-Number(bool(a.favorite))||String(a.name||a.title||'').localeCompare(String(b.name||b.title||''),'fa')});return{handled:true,result:{items:rows.slice(page.offset,page.offset+page.limit).map(cleanForClient),total:rows.length}};}
  if(request.method==='GET'&&id)return{handled:true,result:cleanForClient(await repo.getById(sheet,id))};
  if(request.method==='POST'&&!id){const body=await bodyJson(request),headers=await repo.headers(sheet),row={};for(const header of headers)if(body[header]!==undefined&&!['__row','created_at','updated_at','schema_version'].includes(header))row[header]=body[header];if(!row[idField])row[idField]=uuid();entityDefaults(sheet,row);normalizeEntityMoney(sheet,row,currencyCode(body.input_currency||DEFAULT_CURRENCY));validateEntityInput(sheet,row);row.created_at=nowIso();row.updated_at=nowIso();row.schema_version=SCHEMA_VERSION;return{handled:true,result:await repo.insert(sheet,row)};}
  if(request.method==='PATCH'&&id&&!action){const body=await bodyJson(request),headers=await repo.headers(sheet),patch={};for(const header of headers)if(body[header]!==undefined&&!['__row',idField,'created_at','schema_version'].includes(header))patch[header]=body[header];normalizeEntityMoney(sheet,patch,currencyCode(body.input_currency||DEFAULT_CURRENCY));validateEntityInput(sheet,patch);return{handled:true,result:await repo.updateById(sheet,id,patch)};}
  if(request.method==='DELETE'&&id&&!action){const row=await repo.getById(sheet,id);if(!row)throw new Error('NOT_FOUND');if(url.searchParams.get('permanent')==='true'){const phrase=`DELETE ${id}`;if(request.headers.get('x-confirm-permanent-delete')!==phrase||!bool(row.is_deleted))throw new Error('VALIDATION');await assertEntityCanPermanentlyDelete(repo,sheet,id);return{handled:true,result:{deleted:await repo.permanentDelete(sheet,id)}};}if(!SHEETS[sheet]?.includes('is_deleted'))throw new Error('VALIDATION');return{handled:true,result:await repo.softDelete(sheet,id)};}
  if(request.method==='POST'&&id&&action==='archive'){if(!(await repo.headers(sheet)).includes('archived'))throw new Error('VALIDATION');return{handled:true,result:await repo.archive(sheet,id,true)};}
  if(request.method==='POST'&&id&&action==='restore'){if(!(await repo.headers(sheet)).includes('archived'))throw new Error('VALIDATION');return{handled:true,result:await repo.archive(sheet,id,false)};}
  if(request.method==='POST'&&id&&action==='undelete'){if(!(await repo.headers(sheet)).includes('is_deleted'))throw new Error('VALIDATION');return{handled:true,result:await repo.restore(sheet,id)};}
  return{handled:false};
}

async function lookupBundle(repo){
  const names=['accounts','categories','people','projects','tags','merchants','installments'],out={};for(const name of names){const sheet=ENTITY_MAP[name],rows=await repo.list(sheet,{limit:5000,filter:x=>!bool(x.is_deleted)&&!bool(x.archived),sort:(a,b)=>Number(bool(b.favorite))-Number(bool(a.favorite))||String(a.name||a.title||'').localeCompare(String(b.name||b.title||''),'fa')});out[name]=rows.map(cleanForClient);}return out;
}
const REF_CHECKS={
  Accounts:[['Transactions',['account_id','destination_account_id']],['Installments',['account_id']],['Recurring',['account_id']],['Templates',['account_id']],['Imports',['account_id']],['DebtPayments',['account_id']]],
  Categories:[['Transactions',['category_id']],['Recurring',['category_id']],['Templates',['category_id']],['Merchants',['default_category_id']]],
  People:[['Transactions',['person_id']],['Debts',['person_id']],['Installments',['person_id']],['Recurring',['person_id']],['SplitItems',['person_id']]],
  Projects:[['Transactions',['project_id']],['Debts',['project_id']],['Installments',['project_id']],['Recurring',['project_id']],['Splits',['project_id']],['Templates',['project_id']],['Merchants',['default_project_id']]],
  Tags:[['EntityTags',['tag_id']]],Merchants:[['Transactions',['merchant_id']],['Recurring',['merchant_id']],['Templates',['merchant_id']]],
  Installments:[['InstallmentPayments',['installment_id']]],Debts:[['DebtPayments',['debt_id']]]
};
async function assertEntityCanPermanentlyDelete(repo,sheet,id){
  for(const [target,fields] of REF_CHECKS[sheet]||[]){const hit=await repo.findOne(target,row=>fields.some(f=>String(row[f]||'')===String(id)));if(hit)throw new Error('ENTITY_IN_USE');}
  if(['Categories','Projects'].includes(sheet)){const scope=sheet==='Categories'?'category':'project',hit=await repo.findOne('Budgets',x=>String(x.scope_type)===scope&&String(x.scope_id)===String(id));if(hit)throw new Error('ENTITY_IN_USE');}
  if(['Installments','Debts'].includes(sheet)){const type=sheet==='Installments'?'installment':'debt',hit=await repo.findOne('Links',x=>(x.from_type===type&&String(x.from_id)===String(id))||(x.to_type===type&&String(x.to_id)===String(id)));if(hit)throw new Error('ENTITY_IN_USE');}
}
async function trashItems(repo){
  const txs=await repo.list('Transactions',{limit:10000,filter:x=>bool(x.is_deleted)}),items=txs.map(x=>({...cleanForClient(x),trash_kind:'transaction',entity_name:'transactions',entity_id:x.transaction_id,title:x.description||x.type||'تراکنش'}));
  for(const [name,sheet] of Object.entries(ENTITY_MAP)){if(!SHEETS[sheet]?.includes('is_deleted'))continue;const rows=await repo.list(sheet,{limit:5000,filter:x=>bool(x.is_deleted)});for(const x of rows)items.push({...cleanForClient(x),trash_kind:'entity',entity_name:name,entity_id:x[ID_FIELD[sheet]],title:x.name||x.title||x.scope_type||sheet});}
  items.sort((a,b)=>String(b.deleted_at||'').localeCompare(String(a.deleted_at||'')));return{items};
}

async function replaceTransactionTags(repo,transactionId,tagIds){
  if(!await repo.getById('Transactions',transactionId))throw new Error('NOT_FOUND');const unique=[...new Set(tagIds.map(String).filter(Boolean))];for(const id of unique)if(!await repo.getById('Tags',id))throw new Error('VALIDATION');
  const current=await repo.list('EntityTags',{limit:5000,filter:x=>x.entity_type==='transaction'&&x.entity_id===transactionId});
  for(const join of current.filter(x=>!unique.includes(x.tag_id)))await repo.permanentDelete('EntityTags',join.entity_tag_id);
  const existing=new Set(current.map(x=>x.tag_id));for(const tagId of unique.filter(id=>!existing.has(id)))await repo.insert('EntityTags',{entity_tag_id:uuid(),entity_type:'transaction',entity_id:transactionId,tag_id:tagId,created_at:nowIso(),schema_version:SCHEMA_VERSION});
  return{tag_ids:unique};
}
async function txDetail(repo,id){
  const transaction=await repo.getById('Transactions',id);if(!transaction)throw new Error('NOT_FOUND');const [receipts,joins,tags,links]=await Promise.all([repo.list('Receipts',{limit:100,filter:x=>x.transaction_id===id&&x.ai_status!=='deleted'}),repo.list('EntityTags',{limit:1000,filter:x=>x.entity_type==='transaction'&&x.entity_id===id}),repo.list('Tags',{limit:1000}),repo.list('Links',{limit:2000,filter:x=>x.from_id===id||x.to_id===id})]);const tagMap=Object.fromEntries(tags.map(x=>[x.tag_id,x]));return{transaction:cleanForClient(transaction),receipts:receipts.map(cleanForClient),tags:joins.map(j=>tagMap[j.tag_id]).filter(Boolean).map(cleanForClient),links:links.map(cleanForClient)};
}
function csvCell(v){return '"'+String(v??'').replace(/"/g,'""')+'"';}
async function completeReportCsv(repo,rep,displayCurrency){
  const maps=await lookupBundle(repo),map=(rows,id)=>Object.fromEntries((rows||[]).map(x=>[x[id],x.name||x.title||''])),accounts=map(maps.accounts,'account_id'),categories=map(maps.categories,'category_id'),people=map(maps.people,'person_id'),projects=map(maps.projects,'project_id'),merchants=map(maps.merchants,'merchant_id'),unit=displayCurrency==='TOMAN'?'تومان':'ریال',m=n=>fromRial(Number(n||0),displayCurrency);
  const summary=[['گزارش مالی کامل',''],['از تاریخ',rep.from||''],['تا تاریخ',rep.to||''],['واحد',unit],['تعداد تراکنش',rep.summary.count||0],['درآمد',m(rep.summary.income)],['مخارج خالص',m(rep.summary.net_expense)],['کارمزد',m(rep.summary.fees)],['بازپرداخت',m(rep.summary.refunds)],['خالص',m(rep.summary.net)],['ورودی حساب',m(rep.summary.inflow)],['خروجی حساب',m(rep.summary.outflow)],['جمع انتقال',m(rep.summary.transfers)],[]];
  const headers=['شناسه','تاریخ شمسی','تاریخ ISO','ساعت','نوع','مبلغ '+unit,'کارمزد '+unit,'حساب','حساب مقصد','دسته','شخص','پروژه','فروشنده','شرح','یادداشت','پیگیری','مرجع','منبع','وضعیت'];
  const rows=(rep.transactions||[]).map(t=>[t.transaction_id,t.transaction_date,t.transaction_date_iso,t.transaction_time||'00:00:00',t.type,m(t.amount),m(t.fee_amount),accounts[t.account_id]||'',accounts[t.destination_account_id]||'',categories[t.category_id]||'',people[t.person_id]||'',projects[t.project_id]||'',merchants[t.merchant_id]||'',t.description,t.note,t.tracking_number,t.reference_number,t.source,t.status||'confirmed']);
  return '\ufeff'+[...summary.map(r=>r.map(csvCell).join(',')),headers.map(csvCell).join(','),...rows.map(r=>r.map(csvCell).join(','))].join('\r\n');
}
async function uploadReceipt(request,repo,env){
  if(!hasR2(env))throw new Error('R2_DISABLED');const form=await request.formData(),file=form.get('file'),thumb=form.get('thumb'),original=form.get('original'),transactionId=String(form.get('transaction_id')||'');if(!(file instanceof File)||!transactionId||file.size>8*1024*1024)throw new Error('VALIDATION');const keep=await repo.setting('keep_original_receipts',false);return saveReceipt(repo,env,{transaction_id:transactionId,bytes:await file.arrayBuffer(),mime_type:file.type||'image/webp',thumbBytes:thumb instanceof File?await thumb.arrayBuffer():null,source:'mini_app',keepOriginal:keep,originalBytes:keep&&original instanceof File?await original.arrayBuffer():null});
}
async function optimizeReceipt(request,repo,env,id){const form=await request.formData(),file=form.get('file'),thumb=form.get('thumb');if(!(file instanceof File)||file.type!=='image/webp')throw new Error('VALIDATION');return replaceWithWebp(repo,env,id,{webpBytes:await file.arrayBuffer(),thumbBytes:thumb instanceof File?await thumb.arrayBuffer():null});}
async function receiptResponse(repo,env,id,mode,download){
  const receipt=await repo.getById('Receipts',id);if(!receipt)throw new Error('NOT_FOUND');const key=mode==='original'?(receipt.original_key||receipt.object_key):mode==='thumb'?(receipt.thumb_key||receipt.object_key):receipt.object_key,object=await getPrivate(env,key);if(!object)throw new Error('NOT_FOUND');const mime=object.httpMetadata?.contentType||receipt.mime_type||'application/octet-stream',ext=mime==='image/webp'?'webp':mime==='image/png'?'png':'jpg';const headers=new Headers({'content-type':mime,'cache-control':'private, no-store','content-disposition':download?`attachment; filename="receipt-${id}.${ext}"`:'inline',...securityHeaders()});return new Response(object.body,{headers});
}
async function receiptAi(repo,env,id){
  const receipt=await repo.getById('Receipts',id);if(!receipt)throw new Error('NOT_FOUND');const object=await getPrivate(env,receipt.object_key);if(!object)throw new Error('NOT_FOUND');const ai=await extractReceipt(repo,env,await object.arrayBuffer(),receipt.mime_type||'image/webp');await repo.updateById('Receipts',id,{ai_status:'review',ai_json:JSON.stringify(ai)},{action:'AI-write'});await repo.insert('Inbox',{inbox_id:uuid(),type:'receipt_ai',entity_type:'receipt',entity_id:id,title:'بررسی استخراج فیش',payload_json:JSON.stringify(ai),status:'pending',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});return ai;
}
async function confirmReceiptAi(repo,finance,id,body){
  if(body.confirm!=='APPLY')throw new Error('VALIDATION');const receipt=await repo.getById('Receipts',id);if(!receipt)throw new Error('NOT_FOUND');const ai={...safeJsonParse(receipt.ai_json,{}),...(body.fields||{})},patch={currency:currencyCode(body.currency||await repo.setting('default_currency',DEFAULT_CURRENCY))};
  if(ai.amount!==undefined&&ai.amount!==null)patch.amount=Number(ai.amount);if(ai.fee!==undefined&&ai.fee!==null)patch.fee_amount=Number(ai.fee);if(ai.date)patch.transaction_date=ai.date;if(ai.tracking_number)patch.tracking_number=String(ai.tracking_number);if(ai.reference_number)patch.reference_number=String(ai.reference_number);if(ai.description)patch.description=String(ai.description);
  if(ai.merchant){let merchant=await repo.findOne('Merchants',x=>String(x.name||'').trim().toLowerCase()===String(ai.merchant).trim().toLowerCase());if(!merchant)merchant=await repo.insert('Merchants',{merchant_id:uuid(),name:String(ai.merchant).trim(),default_category_id:'',default_project_id:'',default_tags_json:'[]',icon:'',color:'',favorite:false,archived:false,is_deleted:false,deleted_at:'',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION},{action:'AI-write'});patch.merchant_id=merchant.merchant_id;}
  const transaction=await finance.editTransaction(receipt.transaction_id,patch);await repo.updateById('Receipts',id,{ai_status:'applied'},{action:'AI-write'});const inbox=await repo.findOne('Inbox',x=>x.type==='receipt_ai'&&x.entity_id===id&&x.status==='pending');if(inbox)await repo.updateById('Inbox',inbox.inbox_id,{status:'done'});return transaction;
}

async function uploadImportFile(request,repo,env){if(!hasR2(env))throw new Error('R2_DISABLED');const form=await request.formData(),file=form.get('file');if(!(file instanceof File)||file.size>20*1024*1024)throw new Error('VALIDATION');return saveInboxFile(repo,env,{name:file.name,bytes:await file.arrayBuffer(),mime_type:file.type,source:'mini_app'});}
async function importFileResponse(repo,env,id){const imp=await repo.getById('Imports',id);if(!imp?.object_key)throw new Error('NOT_FOUND');const object=await getPrivate(env,imp.object_key);if(!object)throw new Error('NOT_FOUND');return new Response(object.body,{headers:{'content-type':object.httpMetadata?.contentType||'application/octet-stream','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(imp.file_name||'statement')}`,'cache-control':'private, no-store',...securityHeaders()}});}

async function saveSplit(repo,body){
  const calculation=calculateSplit(body),split=await repo.insert('Splits',{split_id:uuid(),title:body.title||'دنگ',project_id:body.project_id||'',transaction_id:body.transaction_id||'',mode:calculation.mode,total_amount:calculation.total_amount,status:'active',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});
  for(const item of calculation.items)await repo.insert('SplitItems',{split_item_id:uuid(),split_id:split.split_id,person_id:item.person_id||'',name:item.name,paid_amount:item.paid_amount,share_value:item.share_value,share_amount:item.share_amount,balance:item.balance,created_at:nowIso(),schema_version:SCHEMA_VERSION});return{split,calculation};
}
async function splitToReceivables(repo,finance,id,body){
  const split=await repo.getById('Splits',id);if(!split)throw new Error('NOT_FOUND');const items=await repo.list('SplitItems',{limit:1000,filter:x=>x.split_id===id}),calculation=calculateSplit({total_amount:split.total_amount,mode:split.mode,items:items.map(x=>({person_id:x.person_id,name:x.name,paid_amount:x.paid_amount,share_value:split.mode==='custom'?x.share_amount:x.share_value}))}),created=[];
  for(const settlement of calculation.settlements){
    if(!settlement.to.person_id&&settlement.from.person_id)created.push(await finance.createReceivable({person_id:settlement.from.person_id,amount:settlement.amount,currency:'IRR',account_id:body.account_id,project_id:split.project_id,description:`دنگ ${split.title}`,date:body.date||new Date().toISOString().slice(0,10),source:'mini_app'}));
    else if(!settlement.from.person_id&&settlement.to.person_id)created.push(await finance.createDebt({person_id:settlement.to.person_id,amount:settlement.amount,currency:'IRR',account_id:body.account_id||'',project_id:split.project_id,description:`دنگ ${split.title}`,date:body.date||new Date().toISOString().slice(0,10),source:'mini_app'}));
  }
  await repo.updateById('Splits',id,{status:'converted'});return{created};
}

async function restoreReceiptFiles(request,repo,env,id){
  if(!hasR2(env))throw new Error('R2_DISABLED');const receipt=await repo.getById('Receipts',id);if(!receipt)throw new Error('NOT_FOUND');const form=await request.formData(),file=form.get('file'),thumb=form.get('thumb'),original=form.get('original');if(!(file instanceof File)||!receipt.object_key)throw new Error('VALIDATION');await putPrivate(env,receipt.object_key,await file.arrayBuffer(),{contentType:receipt.mime_type||file.type||'application/octet-stream',cacheControl:'private, max-age=0'});if(thumb instanceof File&&receipt.thumb_key)await putPrivate(env,receipt.thumb_key,await thumb.arrayBuffer(),{contentType:'image/webp',cacheControl:'private, max-age=0'});if(original instanceof File&&receipt.original_key)await putPrivate(env,receipt.original_key,await original.arrayBuffer(),{contentType:original.type||'application/octet-stream',cacheControl:'private, max-age=0'});return{restored:true};
}

async function health(repo,env){
  const storage=await probePrivateStorage(env);
  const out={config:validateConfig(env),pin:await pinStatus(repo,env),telegram:{ok:false},google_sheets:{ok:false},storage:{ok:storage.ok,configured:storage.kind!=='none',kind:storage.kind},r2:{ok:storage.ok,configured:storage.kind!=='none'},openrouter:{ok:false,configured:!!env.OPENROUTER_API_KEY},schema:{ok:false,version:SCHEMA_VERSION}};
  try{await repo.spreadsheetInfo();out.google_sheets.ok=true;}catch{}
  try{await telegramCall(env,'getMe',{});out.telegram.ok=true;}catch{}
  try{const caps=await getCapabilities(repo,env);out.openrouter.ok=!!caps.configured&&!!caps.text;out.openrouter.capabilities={text:caps.text,vision:caps.vision,audio:caps.audio,file:caps.file};out.openrouter.model=caps.models?.text?.id||'';out.openrouter.requested_model=caps.requested_models?.text||'';out.openrouter.fallback_used=!!caps.fallback_used;out.openrouter.error=caps.error||'';}catch{}
  try{const migrations=await repo.list('Migrations',{limit:500});out.schema.ok=migrations.some(x=>Number(x.schema_version)===SCHEMA_VERSION);}catch{}
  return out;
}
