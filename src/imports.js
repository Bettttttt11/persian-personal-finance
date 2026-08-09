import { normalizeText, nowIso, parseMoney, safeJsonParse, sha256Hex, uuid, SCHEMA_VERSION } from './utils.js';
import { parseDateInput } from './jalali.js';

export function parseCsv(text){
  text=String(text||'').replace(/^\ufeff/,'');const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i],next=text[i+1];if(quoted){if(c==='"'&&next==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}
  if(cell||row.length){row.push(cell);rows.push(row);}return rows.filter(r=>r.some(x=>String(x).trim()!==''));
}
export function rowsFromCsv(text,mapping={}){
  const rows=parseCsv(text);if(rows.length<2)return[];const headers=rows[0].map(normalizeText);
  const aliases={date:['date','تاریخ','transaction date'],amount:['amount','مبلغ','برداشت','واریز'],description:['description','شرح','توضیحات'],tracking_number:['tracking','شماره پیگیری','پیگیری'],reference_number:['reference','شماره مرجع','مرجع'],bank_transaction_id:['transaction id','شناسه تراکنش','bank id'],type:['type','نوع']};
  const idx=key=>mapping[key]!==undefined?Number(mapping[key]):headers.findIndex(h=>(aliases[key]||[]).some(x=>h.includes(normalizeText(x))));
  return rows.slice(1).map((r,i)=>({row_index:i+2,date:r[idx('date')]||'',amount:r[idx('amount')]||'',description:r[idx('description')]||'',tracking_number:r[idx('tracking_number')]||'',reference_number:r[idx('reference_number')]||'',bank_transaction_id:r[idx('bank_transaction_id')]||'',type:r[idx('type')]||''}));
}
function inferType(row){const t=normalizeText(row.type||'');if(/income|واریز|بستانکار/.test(t))return'income';if(/transfer|انتقال/.test(t))return'transfer';if(/refund|برگشت/.test(t))return'refund';return'expense';}
export async function bankFingerprint({account_id,date,amount,type,description,tracking_number,reference_number}){return sha256Hex([account_id,date,amount,type,normalizeText(description).replace(/\d{6,}/g,'#'),normalizeText(tracking_number),normalizeText(reference_number)].join('|'));}
function similarity(a,b){const A=new Set(normalizeText(a).split(' ').filter(x=>x.length>1)),B=new Set(normalizeText(b).split(' ').filter(x=>x.length>1));if(!A.size&&!B.size)return 1;let inter=0;for(const x of A)if(B.has(x))inter++;return inter/Math.max(A.size,B.size,1);}

export async function previewImport(repo,{file_name='bank.csv',account_id,rows,source='mini_app'}){
  if(!account_id||!Array.isArray(rows)||!rows.length)throw new Error('VALIDATION');
  const contentFingerprint=await sha256Hex(JSON.stringify({account_id,rows:rows.map(r=>({date:r.date,amount:r.amount,description:r.description,tracking_number:r.tracking_number,reference_number:r.reference_number,bank_transaction_id:r.bank_transaction_id,type:r.type}))}));
  const previous=await repo.findOne('Imports',x=>x.content_fingerprint===contentFingerprint&&['review','confirmed'].includes(x.status));
  if(previous){const items=await repo.list('ImportItems',{limit:10000,filter:x=>x.import_id===previous.import_id});return{import:previous,items,counts:{total:items.length,new:items.filter(x=>x.status==='new').length,duplicate:items.filter(x=>x.status==='duplicate').length,suspect:items.filter(x=>x.status==='suspect').length,invalid:items.filter(x=>x.status==='invalid').length},idempotent:true};}
  const importId=uuid(),txs=await repo.list('Transactions',{limit:20000,includeDeleted:false}),items=[];let duplicate=0,suspect=0,fresh=0;
  for(const raw of rows){
    let normalized,status='new',matched='',fp='';
    try{
      const amount=parseMoney(raw.amount),date=parseDateInput(raw.date),type=inferType(raw);normalized={account_id,date,amount:Math.abs(amount),type,description:String(raw.description||''),tracking_number:String(raw.tracking_number||''),reference_number:String(raw.reference_number||''),bank_transaction_id:String(raw.bank_transaction_id||'')};fp=await bankFingerprint(normalized);normalized.bank_fingerprint=fp;
      let exact=null;if(normalized.bank_transaction_id)exact=txs.find(t=>t.bank_transaction_id&&t.bank_transaction_id===normalized.bank_transaction_id);
      if(!exact&&(normalized.tracking_number||normalized.reference_number))exact=txs.find(t=>(normalized.tracking_number&&t.tracking_number===normalized.tracking_number)||(normalized.reference_number&&t.reference_number===normalized.reference_number));
      if(!exact)exact=txs.find(t=>t.bank_fingerprint&&t.bank_fingerprint===fp);
      if(exact){status='duplicate';matched=exact.transaction_id;duplicate++;}
      else{const candidates=txs.filter(t=>t.account_id===account_id&&t.transaction_date_iso===date&&Number(t.amount||0)===normalized.amount&&t.type===type),maybe=candidates.sort((a,b)=>similarity(b.description,normalized.description)-similarity(a.description,normalized.description))[0];if(maybe&&similarity(maybe.description,normalized.description)>=0.25){status='suspect';matched=maybe.transaction_id;suspect++;}else fresh++;}
      items.push({item_id:uuid(),import_id:importId,row_index:raw.row_index||items.length+1,raw_json:JSON.stringify(raw),normalized_json:JSON.stringify(normalized),status,matched_transaction_id:matched,fingerprint:fp,created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});
    }catch{items.push({item_id:uuid(),import_id:importId,row_index:raw.row_index||items.length+1,raw_json:JSON.stringify(raw),normalized_json:'{}',status:'invalid',matched_transaction_id:'',fingerprint:'',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});}
  }
  const imp=await repo.insert('Imports',{import_id:importId,file_name,account_id,source,object_key:'',content_fingerprint:contentFingerprint,status:'review',total_count:items.length,new_count:fresh,duplicate_count:duplicate,suspect_count:suspect,created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});
  for(const item of items)await repo.insert('ImportItems',item,{audit:false});
  await repo.insert('Inbox',{inbox_id:uuid(),type:'bank_import',entity_type:'import',entity_id:importId,title:`بررسی ورود ${file_name}`,payload_json:JSON.stringify({new:fresh,duplicate,suspect}),status:'pending',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});
  return{import:imp,items,counts:{total:items.length,new:fresh,duplicate,suspect,invalid:items.filter(x=>x.status==='invalid').length}};
}

export async function confirmImport(repo,finance,importId,decisions={}){
  const imp=await repo.getById('Imports',importId);if(!imp)throw new Error('NOT_FOUND');const items=await repo.list('ImportItems',{limit:10000,filter:x=>x.import_id===importId}),created=[],linked=[],skipped=[];
  for(const item of items){
    if(['created','linked'].includes(item.status)){(item.status==='created'?created:linked).push(item.matched_transaction_id);continue;}
    const choice=decisions[item.item_id]||item.status;if(['duplicate','skip','invalid'].includes(choice)||item.status==='invalid'){skipped.push(item.item_id);continue;}const n=JSON.parse(item.normalized_json);
    if(choice==='link'&&item.matched_transaction_id){
      const existing=await repo.getById('Transactions',item.matched_transaction_id),meta=safeJsonParse(existing?.metadata_json,{});
      await finance.editTransaction(item.matched_transaction_id,{bank_transaction_id:n.bank_transaction_id||existing.bank_transaction_id,tracking_number:n.tracking_number||existing.tracking_number,reference_number:n.reference_number||existing.reference_number,bank_fingerprint:n.bank_fingerprint,import_batch_id:importId,metadata_json:JSON.stringify({...meta,reconciled:true,bank_import:{import_id:importId,item_id:item.item_id,description:n.description}})});
      await finance.link('import_item',item.item_id,'transaction',item.matched_transaction_id,'reconciled');await repo.updateById('ImportItems',item.item_id,{status:'linked'},{audit:false});linked.push(item.matched_transaction_id);continue;
    }
    if(choice==='suspect')throw new Error('IMPORT_REVIEW_REQUIRED');
    const tx=await finance.createTransaction({type:n.type,amount:n.amount,account_id:imp.account_id,transaction_date_iso:n.date,description:n.description,tracking_number:n.tracking_number,reference_number:n.reference_number,bank_transaction_id:n.bank_transaction_id,bank_fingerprint:n.bank_fingerprint,import_batch_id:importId},'bank_import');
    await repo.updateById('ImportItems',item.item_id,{status:'created',matched_transaction_id:tx.transaction_id},{audit:false});created.push(tx.transaction_id);
  }
  await repo.updateById('Imports',importId,{status:'confirmed'});const inbox=await repo.findOne('Inbox',x=>x.type==='bank_import'&&x.entity_id===importId&&x.status==='pending');if(inbox)await repo.updateById('Inbox',inbox.inbox_id,{status:'done'});return{created,linked,skipped};
}
