import { SCHEMA_VERSION, nowIso, safeJsonParse, tehranTime, uuid } from './utils.js';
export const SHEETS={
 Transactions:['transaction_id','type','amount','currency','transaction_date','transaction_date_iso','transaction_time','created_at','updated_at','account_id','destination_account_id','category_id','person_id','project_id','merchant_id','description','note','fee_amount','fee_note','tracking_number','reference_number','bank_transaction_id','receipt_count','status','source','parent_transaction_id','is_starred','is_deleted','deleted_at','created_by','import_batch_id','bank_fingerprint','metadata_json','schema_version'],
 Accounts:['account_id','name','type','opening_balance','color','icon','favorite','archived','is_deleted','deleted_at','note','created_at','updated_at','schema_version'],
 Categories:['category_id','name','icon','color','type','favorite','archived','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 People:['person_id','name','phone','note','color','favorite','archived','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 Projects:['project_id','name','description','icon','color','budget','start_date','end_date','status','favorite','archived','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 Installments:['installment_id','title','total_amount','installment_count','default_installment_amount','start_date','due_day','due_dates_json','person_id','account_id','project_id','status','note','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 InstallmentPayments:['payment_id','installment_id','transaction_id','amount','fee_amount','payment_date','note','created_at','schema_version'],
 Tags:['tag_id','name','color','favorite','archived','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 Merchants:['merchant_id','name','default_category_id','default_project_id','default_tags_json','icon','color','favorite','archived','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 Rules:['rule_id','name','priority','enabled','conditions_json','actions_json','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 Drafts:['draft_id','kind','owner_telegram_id','state_json','status','created_at','updated_at','expires_at','schema_version'],
 ChangeLog:['log_id','entity_type','entity_id','action','before_json','after_json','source','created_at','schema_version'],
 Settings:['setting_id','key','value_json','updated_at','schema_version'],
 Receipts:['receipt_id','transaction_id','object_key','thumb_key','mime_type','size_bytes','original_key','source','ai_status','ai_json','created_at','schema_version'],
 Debts:['debt_id','kind','person_id','principal_amount','settled_amount','status','due_date','note','project_id','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 DebtPayments:['payment_id','debt_id','transaction_id','amount','fee_amount','payment_date','account_id','note','created_at','schema_version'],
 Recurring:['recurring_id','title','type','amount','frequency','custom_json','next_due_date','account_id','category_id','person_id','project_id','merchant_id','enabled','note','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 Budgets:['budget_id','scope_type','scope_id','period','amount','warning_thresholds_json','active','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 Splits:['split_id','title','project_id','transaction_id','mode','total_amount','status','created_at','updated_at','schema_version'],
 SplitItems:['split_item_id','split_id','person_id','name','paid_amount','share_value','share_amount','balance','created_at','schema_version'],
 Inbox:['inbox_id','type','entity_type','entity_id','title','payload_json','status','created_at','updated_at','schema_version'],
 Imports:['import_id','file_name','account_id','source','object_key','content_fingerprint','status','total_count','new_count','duplicate_count','suspect_count','created_at','updated_at','schema_version'],
 ImportItems:['item_id','import_id','row_index','raw_json','normalized_json','status','matched_transaction_id','fingerprint','created_at','updated_at','schema_version'],
 Templates:['template_id','name','type','account_id','category_id','merchant_id','project_id','tags_json','description','favorite','archived','is_deleted','deleted_at','created_at','updated_at','schema_version'],
 Sessions:['session_id','channel','telegram_id','token_hash','created_at','last_seen_at','expires_at','revoked_at','schema_version'],
 Migrations:['migration_id','schema_version','applied_at','details_json'],
 EntityTags:['entity_tag_id','entity_type','entity_id','tag_id','created_at','schema_version'],
 Links:['link_id','from_type','from_id','to_type','to_id','relation','metadata_json','created_at','schema_version'],
 ProcessedUpdates:['processed_id','update_id','created_at','schema_version'],
 AuthState:['auth_state_id','telegram_id','pin_fail_count','lock_until','updated_at','schema_version'],
 Idempotency:['idempotency_id','key','scope','response_json','created_at','expires_at','schema_version']
};
export const ID_FIELD=Object.fromEntries(Object.entries(SHEETS).map(([s,h])=>[s,h[0]]));
export const INITIAL_CATEGORIES=['غذا','کافه','حمل و نقل','خرید','خانه','تفریح','درمان','آموزش','قبض','اینترنت','قسط','کارمزد','سایر'];
function q(name){return `'${String(name).replace(/'/g,"''")}'`;}
const LEGACY_MONEY_FIELDS={
  Transactions:['amount','fee_amount'],Accounts:['opening_balance'],Projects:['budget'],Installments:['total_amount','default_installment_amount'],InstallmentPayments:['amount','fee_amount'],Debts:['principal_amount','settled_amount'],DebtPayments:['amount','fee_amount'],Recurring:['amount'],Budgets:['amount'],Splits:['total_amount'],SplitItems:['paid_amount','share_amount','balance']
};
function rialize(v){if(v===''||v===null||v===undefined)return v;const n=Number(v);return Number.isFinite(n)?n*10:v;}
function timeFromCreatedAt(value){
  try{const d=new Date(value);if(Number.isNaN(d.getTime()))return '00:00:00';return tehranTime(d);}catch{return '00:00:00';}
}
async function migrateTransactionTimes(repo){
  if(await repo.setting('transaction_time_v8',false))return 0;
  const rows=await repo.list('Transactions',{limit:50000}),missing=rows.filter(r=>!String(r.transaction_time||'').trim());
  if(missing.length){const patched=missing.map(input=>{const row={...input};delete row.__row;row.transaction_time=timeFromCreatedAt(row.created_at);row.schema_version=SCHEMA_VERSION;return row;});await repo.bulkUpsert('Transactions',patched,{overwrite:true,audit:false,action:'transaction_time_v8'});}
  await repo.setSetting('transaction_time_v8',true);return missing.length;
}
async function migrateLegacyTomanToRial(repo){
  const splitModes=new Map((await repo.list('Splits',{limit:20000})).map(x=>[String(x.split_id),String(x.mode||'equal')]));
  for(const [sheet,fields] of Object.entries(LEGACY_MONEY_FIELDS)){
    const marker=`currency_v7_${sheet}`;if(await repo.setting(marker,false))continue;
    const rows=await repo.list(sheet,{limit:50000}),legacy=rows.filter(row=>Number(row.schema_version||0)<SCHEMA_VERSION);
    if(legacy.length){const converted=legacy.map(input=>{const row={...input};delete row.__row;for(const field of fields)row[field]=rialize(row[field]);
      if(sheet==='Transactions'){row.currency='IRR';if(row.type==='adjustment'){const meta=safeJsonParse(row.metadata_json,{});if(meta&&Number.isFinite(Number(meta.delta))){meta.delta=Number(meta.delta)*10;row.metadata_json=JSON.stringify(meta);}}}
      if(sheet==='SplitItems'&&splitModes.get(String(row.split_id))==='custom')row.share_value=rialize(row.share_value);
      row.schema_version=SCHEMA_VERSION;return row;});
      await repo.bulkUpsert(sheet,converted,{overwrite:true,audit:false,action:'currency_migration_v7'});
    }
    await repo.setSetting(marker,true);
  }
  if(!await repo.setting('currency_v7_drafts',false)){const drafts=await repo.list('Drafts',{limit:10000,filter:x=>x.status==='active'});for(const d of drafts)await repo.updateById('Drafts',d.draft_id,{status:'discarded',updated_at:nowIso()},{audit:false});await repo.setSetting('currency_v7_drafts',true);}
  await repo.setSetting('storage_currency','IRR');
}
export async function migrate(repo){
  const info=await repo.spreadsheetInfo(); const existing=new Set((info.sheets||[]).map(s=>s.properties.title));
  const missingSheets=Object.keys(SHEETS).filter(name=>!existing.has(name));
  if(missingSheets.length)await repo.g.batchUpdate(missingSheets.map(title=>({addSheet:{properties:{title}}})));

  const names=Object.keys(SHEETS); const headerResponse=await repo.g.valuesBatchGet(names.map(name=>`${q(name)}!1:1`)); const headerWrites=[];
  names.forEach((name,i)=>{const current=(headerResponse.valueRanges?.[i]?.values?.[0]||[]).map(String);const required=SHEETS[name];const merged=[...current,...required.filter(h=>!current.includes(h))];repo.primeHeaders(name,merged);if(merged.length!==current.length||current.length===0)headerWrites.push({range:`${q(name)}!A1`,majorDimension:'ROWS',values:[merged]});});
  if(headerWrites.length)await repo.g.valuesBatchUpdate(headerWrites);

  const migs=await repo.list('Migrations',{limit:2000}),already=migs.some(x=>Number(x.schema_version)===SCHEMA_VERSION);
  if(!already){
    const currencyAlreadyMigrated=await repo.setting('currency_v7_Transactions',false);
    await migrateLegacyTomanToRial(repo);
    await migrateTransactionTimes(repo);
    if(!currencyAlreadyMigrated){const currentCurrency=await repo.findOne('Settings',x=>x.key==='default_currency');if(currentCurrency)await repo.updateById('Settings',currentCurrency.setting_id,{value_json:JSON.stringify('IRR'),updated_at:nowIso(),schema_version:SCHEMA_VERSION},{audit:false});}
    await repo.batchInsert('Migrations',[{migration_id:uuid(),schema_version:SCHEMA_VERSION,applied_at:nowIso(),details_json:JSON.stringify({sheets:names,added_sheets:missingSheets,currency_storage:'IRR',legacy_toman_converted:!currencyAlreadyMigrated,transaction_time_backfilled:true})}],{audit:false});
  }

  const cats=await repo.list('Categories',{limit:200,includeDeleted:false});
  if(cats.length===0){const t=nowIso();await repo.batchInsert('Categories',INITIAL_CATEGORIES.map(name=>({category_id:uuid(),name,icon:'',color:'',type:'expense',favorite:false,archived:false,is_deleted:false,deleted_at:'',created_at:t,updated_at:t,schema_version:SCHEMA_VERSION})),{audit:false});}

  const defaults={schema_version:SCHEMA_VERSION,default_currency:'IRR',storage_currency:'IRR',session_timeout:'1h',keep_original_receipts:false,receipt_quality:78,receipt_max_side:1600,budget_thresholds:[80,90,100]};
  const settings=await repo.list('Settings',{limit:5000}); const have=new Set(settings.map(x=>x.key)); const t=nowIso(); const additions=Object.entries(defaults).filter(([key])=>!have.has(key)).map(([key,val])=>({setting_id:uuid(),key,value_json:JSON.stringify(val),updated_at:t,schema_version:SCHEMA_VERSION}));
  if(additions.length)await repo.batchInsert('Settings',additions,{audit:false});
  return {schema_version:SCHEMA_VERSION,sheets:names.length,created_sheets:missingSheets.length,headers_updated:headerWrites.length,currency_storage:'IRR',legacy_toman_converted:!already};
}
