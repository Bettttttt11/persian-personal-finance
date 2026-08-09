import { GoogleSheetsClient } from './google.js';
import { ID_FIELD } from './schema.js';
import { SCHEMA_VERSION, nowIso, uuid, safeJsonParse } from './utils.js';
function q(name){return `'${String(name).replace(/'/g,"''")}'`;}
function colName(n){ let s=''; for(n++;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s; return s; }
export class Repository{
  constructor(env,source='system'){this.env=env;this.g=new GoogleSheetsClient(env);this.source=source;this.cache=new Map();this.tableCache=new Map();}
  spreadsheetInfo(){return this.g.metadata();}
  async createSheet(name){await this.g.createSheet(name);this.cache.delete(name);this.tableCache.delete(name);}
  primeHeaders(name,headers){this.cache.set(name,{headers:[...headers]});this.tableCache.delete(name);}
  async headers(name,refresh=false){ if(!refresh&&this.cache.has(name)) return this.cache.get(name).headers; const r=await this.g.valuesGet(`${q(name)}!1:1`); const h=(r.values?.[0]||[]).map(String); this.cache.set(name,{headers:h}); return h; }
  async ensureHeaders(name,required){ const h=await this.headers(name,true); const missing=required.filter(x=>!h.includes(x)); if(!h.length){await this.g.valuesUpdate(`${q(name)}!A1`,[required]);} else if(missing.length){ const start=colName(h.length); await this.g.valuesUpdate(`${q(name)}!${start}1`,[missing]); } this.cache.delete(name);this.tableCache.delete(name);return [...h,...missing]; }
  async table(name,refresh=false){if(!refresh&&this.tableCache.has(name))return this.tableCache.get(name);const r=await this.g.valuesGet(`${q(name)}!A:ZZ`); const vals=r.values||[]; const headers=(vals[0]||[]).map(String); const rows=[]; for(let i=1;i<vals.length;i++){ const obj={__row:i+1}; headers.forEach((h,c)=>obj[h]=vals[i]?.[c]??''); if(Object.values(obj).some((v,k)=>k!==0&&v!==''))rows.push(obj); } this.cache.set(name,{headers});const out={headers,rows};this.tableCache.set(name,out);return out;}
  async list(name,{limit=5000,offset=0,filter=null,includeDeleted=true,sort=null}={}){ let {rows}=await this.table(name); if(!includeDeleted)rows=rows.filter(r=>String(r.is_deleted)!=='true'); if(filter)rows=rows.filter(filter); if(sort)rows.sort(sort); return rows.slice(offset,offset+limit); }
  async findOne(name,predicate){ const {rows}=await this.table(name); return rows.find(predicate)||null; }
  async getById(name,id){ const field=ID_FIELD[name]; if(!field)throw new Error('VALIDATION'); return this.findOne(name,r=>String(r[field])===String(id)); }
  async insert(name,data,{audit=true,action='create'}={}){
    const headers=await this.headers(name); const idField=ID_FIELD[name]; const row={...data}; if(idField&&!row[idField])row[idField]=uuid(); if(headers.includes('schema_version')&&!row.schema_version)row.schema_version=SCHEMA_VERSION; if(headers.includes('created_at')&&!row.created_at)row.created_at=nowIso(); if(headers.includes('updated_at')&&!row.updated_at)row.updated_at=nowIso();
    await this.g.valuesAppend(`${q(name)}!A:${colName(Math.max(0,headers.length-1))}`,[headers.map(h=>serialize(row[h]))]);this.tableCache.delete(name);
    if(audit&&name!=='ChangeLog')await this.audit(name,row[idField]||'',action,null,row); return row;
  }
  async batchInsert(name,rows,{audit=false,action='create'}={}){
    if(!Array.isArray(rows)||rows.length===0)return []; const headers=await this.headers(name); const idField=ID_FIELD[name]; const prepared=rows.map(data=>{const row={...data};if(idField&&!row[idField])row[idField]=uuid();if(headers.includes('schema_version')&&!row.schema_version)row.schema_version=SCHEMA_VERSION;if(headers.includes('created_at')&&!row.created_at)row.created_at=nowIso();if(headers.includes('updated_at')&&!row.updated_at)row.updated_at=nowIso();return row;});
    await this.g.valuesAppend(`${q(name)}!A:${colName(Math.max(0,headers.length-1))}`,prepared.map(row=>headers.map(h=>serialize(row[h]))));this.tableCache.delete(name);
    if(audit&&name!=='ChangeLog')for(const row of prepared)await this.audit(name,row[idField]||'',action,null,row); return prepared;
  }
  async bulkUpsert(name,rows,{overwrite=false,action='bulk_restore',audit=true}={}){
    if(!Array.isArray(rows)||rows.length===0)return{inserted:0,updated:0,skipped:0};const headers=await this.headers(name),idField=ID_FIELD[name],table=await this.table(name),byId=new Map(idField?table.rows.map(r=>[String(r[idField]),r]):[]),inserts=[],updates=[],logs=[];
    for(const input of rows){const row={...input};delete row.__row;if(idField&&!row[idField])row[idField]=uuid();if(headers.includes('schema_version')&&!row.schema_version)row.schema_version=SCHEMA_VERSION;if(headers.includes('updated_at'))row.updated_at=nowIso();const before=idField?byId.get(String(row[idField])):null;if(before){if(!overwrite)continue;const after={...before,...row};updates.push({range:`${q(name)}!A${before.__row}:${colName(Math.max(0,headers.length-1))}${before.__row}`,majorDimension:'ROWS',values:[headers.map(h=>serialize(after[h]))]});logs.push({before,after,id:row[idField]});}else{if(headers.includes('created_at')&&!row.created_at)row.created_at=nowIso();inserts.push(row);logs.push({before:null,after:row,id:idField?row[idField]:''});}}
    for(let i=0;i<updates.length;i+=500)await this.g.valuesBatchUpdate(updates.slice(i,i+500));for(let i=0;i<inserts.length;i+=1000){const batch=inserts.slice(i,i+1000);await this.g.valuesAppend(`${q(name)}!A:${colName(Math.max(0,headers.length-1))}`,batch.map(row=>headers.map(h=>serialize(row[h]))));}
    this.tableCache.delete(name);if(audit&&name!=='ChangeLog'&&logs.length){const clean=x=>{if(!x)return null;const y={...x};delete y.__row;return y;};await this.batchInsert('ChangeLog',logs.map(x=>({log_id:uuid(),entity_type:name,entity_id:x.id,action,before_json:JSON.stringify(clean(x.before)),after_json:JSON.stringify(clean(x.after)),source:this.source,created_at:nowIso(),schema_version:SCHEMA_VERSION})),{audit:false});}
    return{inserted:inserts.length,updated:updates.length,skipped:rows.length-inserts.length-updates.length};
  }
  async updateById(name,id,patch,{audit=true,action='update'}={}){
    const before=await this.getById(name,id); if(!before)throw new Error('NOT_FOUND'); const headers=await this.headers(name); const after={...before,...patch}; if(headers.includes('updated_at'))after.updated_at=nowIso(); const data=[];
    for(const [k,v] of Object.entries(after)){ if(k==='__row'||before[k]===v)continue; const idx=headers.indexOf(k); if(idx>=0)data.push({range:`${q(name)}!${colName(idx)}${before.__row}`,majorDimension:'ROWS',values:[[serialize(v)]]}); }
    if(data.length){await this.g.valuesBatchUpdate(data);this.tableCache.delete(name);} if(audit&&name!=='ChangeLog')await this.audit(name,id,action,before,after); return after;
  }
  async softDelete(name,id){ const h=await this.headers(name); if(!h.includes('is_deleted'))throw new Error('VALIDATION'); return this.updateById(name,id,{is_deleted:true,deleted_at:nowIso()},{action:'soft_delete'}); }
  async restore(name,id){ return this.updateById(name,id,{is_deleted:false,deleted_at:''},{action:'restore'}); }
  async archive(name,id,archived=true){ return this.updateById(name,id,{archived},{action:archived?'archive':'unarchive'}); }
  async permanentDelete(name,id){ const before=await this.getById(name,id); if(!before)throw new Error('NOT_FOUND'); const meta=await this.spreadsheetInfo(); const sheet=meta.sheets.find(x=>x.properties.title===name); if(!sheet)throw new Error('NOT_FOUND'); await this.audit(name,id,'permanent_delete',before,null); await this.g.batchUpdate([{deleteDimension:{range:{sheetId:sheet.properties.sheetId,dimension:'ROWS',startIndex:before.__row-1,endIndex:before.__row}}}]);this.tableCache.delete(name);return true; }
  async audit(entityType,entityId,action,before,after){ const sanitize=x=>{if(!x)return null; const y={...x}; delete y.__row; if(entityType==='Sessions'){delete y.token_hash;} return y;}; await this.insert('ChangeLog',{log_id:uuid(),entity_type:entityType,entity_id:entityId,action,before_json:JSON.stringify(sanitize(before)),after_json:JSON.stringify(sanitize(after)),source:this.source,created_at:nowIso(),schema_version:SCHEMA_VERSION},{audit:false}); }
  async setting(key,fallback=null){ const r=await this.findOne('Settings',x=>x.key===key); return r?safeJsonParse(r.value_json,fallback):fallback; }
  async setSetting(key,value){ const r=await this.findOne('Settings',x=>x.key===key); if(r)return this.updateById('Settings',r.setting_id,{value_json:JSON.stringify(value)}); return this.insert('Settings',{setting_id:uuid(),key,value_json:JSON.stringify(value),updated_at:nowIso(),schema_version:SCHEMA_VERSION}); }
  async idempotent(key,scope,fn){ const full=await this.findOne('Idempotency',r=>r.key===key&&r.scope===scope&&(!r.expires_at||r.expires_at>nowIso())); if(full)return safeJsonParse(full.response_json,{}); const result=await fn(); await this.insert('Idempotency',{idempotency_id:uuid(),key,scope,response_json:JSON.stringify(result),created_at:nowIso(),expires_at:new Date(Date.now()+7*864e5).toISOString(),schema_version:SCHEMA_VERSION},{audit:false}); return result; }
}
function serialize(v){ if(v===undefined||v===null)return ''; if(typeof v==='object')return JSON.stringify(v); return v; }
