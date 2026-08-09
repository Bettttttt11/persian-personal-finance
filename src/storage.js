import { SCHEMA_VERSION, nowIso, uuid } from './utils.js';

export function storageKind(env){
  if(env.RECEIPTS_KV)return 'kv';
  if(env.RECEIPTS_BUCKET)return 'r2';
  return 'none';
}

// Kept for backward compatibility with the rest of the project.
export function hasR2(env){return storageKind(env)!=='none';}
export const hasStorage=hasR2;

function extForMime(m=''){
  return m==='image/webp'?'webp':m==='image/png'?'png':m==='application/pdf'?'pdf':m==='text/csv'?'csv':m.includes('sheet')?'xlsx':'jpg';
}

function bodySize(body){
  if(body==null)return 0;
  if(typeof body==='string')return new TextEncoder().encode(body).byteLength;
  if(body instanceof ArrayBuffer)return body.byteLength;
  if(ArrayBuffer.isView(body))return body.byteLength;
  if(typeof Blob!=='undefined'&&body instanceof Blob)return body.size;
  return 0;
}

export async function putPrivate(env,key,body,httpMetadata={}){
  const kind=storageKind(env);
  if(kind==='none')throw new Error('R2_DISABLED');
  if(kind==='r2')return env.RECEIPTS_BUCKET.put(key,body,{httpMetadata});
  const metadata={
    contentType:httpMetadata.contentType||'application/octet-stream',
    cacheControl:httpMetadata.cacheControl||'private, max-age=0',
    sizeBytes:bodySize(body),
    storedAt:nowIso()
  };
  return env.RECEIPTS_KV.put(key,body,{metadata});
}

export async function getPrivate(env,key){
  const kind=storageKind(env);
  if(kind==='none')throw new Error('R2_DISABLED');
  if(kind==='r2')return env.RECEIPTS_BUCKET.get(key);
  const result=await env.RECEIPTS_KV.getWithMetadata(key,{type:'arrayBuffer'});
  if(!result?.value)return null;
  const bytes=result.value;
  const metadata=result.metadata||{};
  return {
    body:bytes,
    size:Number(metadata.sizeBytes||bytes.byteLength||0),
    httpMetadata:{
      contentType:metadata.contentType||'application/octet-stream',
      cacheControl:metadata.cacheControl||'private, max-age=0'
    },
    arrayBuffer:async()=>bytes
  };
}

export async function deletePrivate(env,keys){
  const kind=storageKind(env);
  if(kind==='none')throw new Error('R2_DISABLED');
  const list=Array.isArray(keys)?keys:[keys];
  if(kind==='r2')return env.RECEIPTS_BUCKET.delete(Array.isArray(keys)?list:list[0]);
  await Promise.all(list.filter(Boolean).map(key=>env.RECEIPTS_KV.delete(key)));
}

export async function probePrivateStorage(env){
  const kind=storageKind(env);
  if(kind==='none')return {ok:false,kind:'none'};
  try{
    if(kind==='r2')await env.RECEIPTS_BUCKET.list({limit:1});
    else await env.RECEIPTS_KV.list({limit:1});
    return {ok:true,kind};
  }catch{
    return {ok:false,kind};
  }
}

async function listPrivateMeta(env,{prefix='',limit=1000,cursor}={}){
  const kind=storageKind(env);
  if(kind==='none')return {objects:[],truncated:false,cursor:undefined};
  if(kind==='r2'){
    const out=await env.RECEIPTS_BUCKET.list({prefix,limit,cursor});
    return {objects:(out.objects||[]).map(o=>({key:o.key,size:Number(o.size||0)})),truncated:!!out.truncated,cursor:out.cursor};
  }
  const out=await env.RECEIPTS_KV.list({prefix,limit,cursor});
  return {
    objects:(out.keys||[]).map(k=>({key:k.name,size:Number(k.metadata?.sizeBytes||0)})),
    truncated:out.list_complete===false,
    cursor:out.list_complete===false?out.cursor:undefined
  };
}

export async function saveReceipt(repo,env,{transaction_id,bytes,mime_type='image/webp',thumbBytes=null,source='mini_app',keepOriginal=false,originalBytes=null}){
  if(!hasR2(env))throw new Error('R2_DISABLED');
  const tx=await repo.getById('Transactions',transaction_id);
  if(!tx)throw new Error('NOT_FOUND');
  const rid=uuid(),year=String(tx.transaction_date_iso||new Date().getUTCFullYear()).slice(0,4),ext=extForMime(mime_type);
  const base=`receipts/${year}/${transaction_id}/${rid}`;
  const objectKey=`${base}/receipt.${ext}`;
  await putPrivate(env,objectKey,bytes,{contentType:mime_type,cacheControl:'private, max-age=0'});
  let thumbKey='';
  if(thumbBytes){thumbKey=`${base}/thumb.webp`;await putPrivate(env,thumbKey,thumbBytes,{contentType:'image/webp',cacheControl:'private, max-age=0'});}
  let originalKey='';
  if(keepOriginal&&originalBytes){originalKey=`${base}/original`;await putPrivate(env,originalKey,originalBytes,{contentType:mime_type,cacheControl:'private, max-age=0'});}
  const receipt=await repo.insert('Receipts',{receipt_id:rid,transaction_id,object_key:objectKey,thumb_key:thumbKey,mime_type,size_bytes:bytes.byteLength??bytes.size??0,original_key:originalKey,source,ai_status:'none',ai_json:'',created_at:nowIso(),schema_version:SCHEMA_VERSION});
  await repo.updateById('Transactions',transaction_id,{receipt_count:Number(tx.receipt_count||0)+1});
  return receipt;
}

export async function replaceWithWebp(repo,env,receiptId,{webpBytes,thumbBytes}){
  const r=await repo.getById('Receipts',receiptId);if(!r)throw new Error('NOT_FOUND');
  const base=r.object_key.split('/').slice(0,-1).join('/'),next=`${base}/receipt.webp`,thumb=`${base}/thumb.webp`;
  await putPrivate(env,next,webpBytes,{contentType:'image/webp',cacheControl:'private, max-age=0'});
  let thumbKey=r.thumb_key||'';
  if(thumbBytes){await putPrivate(env,thumb,thumbBytes,{contentType:'image/webp',cacheControl:'private, max-age=0'});thumbKey=thumb;}
  if(r.object_key!==next)await deletePrivate(env,r.object_key);
  return repo.updateById('Receipts',receiptId,{object_key:next,thumb_key:thumbKey,mime_type:'image/webp',size_bytes:webpBytes.byteLength??0});
}

export async function deleteReceipt(repo,env,receiptId){
  const r=await repo.getById('Receipts',receiptId);if(!r)throw new Error('NOT_FOUND');
  const keys=[r.object_key,r.thumb_key,r.original_key].filter(Boolean);
  if(keys.length&&hasR2(env))await deletePrivate(env,keys);
  const tx=await repo.getById('Transactions',r.transaction_id);
  await repo.updateById('Receipts',receiptId,{object_key:'',thumb_key:'',original_key:'',ai_status:'deleted'},{action:'delete_file'});
  if(tx)await repo.updateById('Transactions',tx.transaction_id,{receipt_count:Math.max(0,Number(tx.receipt_count||0)-1)});
  return true;
}

export async function saveInboxFile(repo,env,{name,bytes,mime_type,source='telegram'}){
  if(!hasR2(env))throw new Error('R2_DISABLED');
  const id=uuid(),key=`inbox/${new Date().getUTCFullYear()}/${id}/${encodeURIComponent(name||'file')}`;
  await putPrivate(env,key,bytes,{contentType:mime_type||'application/octet-stream',cacheControl:'private, max-age=0'});
  const imp=await repo.insert('Imports',{import_id:id,file_name:name||'file',account_id:'',source,object_key:key,status:'uploaded',total_count:0,new_count:0,duplicate_count:0,suspect_count:0,created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});
  await repo.insert('Inbox',{inbox_id:uuid(),type:'file',entity_type:'import',entity_id:id,title:`فایل: ${name||'بدون نام'}`,payload_json:JSON.stringify({mime_type}),status:'pending',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});
  return imp;
}

export async function storageStats(repo,env){
  const [tx,drafts,receipts]=await Promise.all([repo.list('Transactions',{limit:50000}),repo.list('Drafts',{limit:10000}),repo.list('Receipts',{limit:50000})]);
  let storage_bytes=0,storage_objects=0,cursor;
  if(hasR2(env)){
    do{
      const x=await listPrivateMeta(env,{prefix:'receipts/',limit:1000,cursor});
      for(const o of x.objects){storage_bytes+=Number(o.size||0);storage_objects++;}
      cursor=x.truncated?x.cursor:undefined;
    }while(cursor&&storage_objects<10000);
  }
  return {
    transactions:tx.length,
    drafts:drafts.filter(x=>x.status==='active').length,
    receipts:receipts.filter(x=>x.ai_status!=='deleted').length,
    storage_kind:storageKind(env),
    storage_bytes,
    storage_objects,
    // compatibility for older UI code
    r2_bytes:storage_bytes,
    r2_objects:storage_objects
  };
}
