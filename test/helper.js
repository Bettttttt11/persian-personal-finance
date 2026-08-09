import { SHEETS, ID_FIELD } from '../src/schema.js';
import { uuid, nowIso, safeJsonParse } from '../src/utils.js';

export class MemoryRepo {
  constructor(env={}){this.env=env;this.data=Object.fromEntries(Object.keys(SHEETS).map(k=>[k,[]]));this.settings=new Map();this.source='test';}
  async headers(name){return SHEETS[name]||[]}
  async list(name,{limit=5000,offset=0,filter=null,includeDeleted=true,sort=null}={}){let rows=(this.data[name]||[]).map((x,i)=>({...x,__row:i+2}));if(!includeDeleted)rows=rows.filter(r=>String(r.is_deleted)!=='true');if(filter)rows=rows.filter(filter);if(sort)rows.sort(sort);return rows.slice(offset,offset+limit)}
  async findOne(name,p){return (await this.list(name,{limit:50000})).find(p)||null}
  async getById(name,id){const f=ID_FIELD[name];return this.findOne(name,r=>String(r[f])===String(id))}
  async insert(name,row,{audit=true,action='create'}={}){const h=SHEETS[name]||Object.keys(row);const x={};for(const k of h)if(row[k]!==undefined)x[k]=typeof row[k]==='object'?JSON.stringify(row[k]):row[k];const id=ID_FIELD[name];if(id&&!x[id])x[id]=uuid();if(h.includes('created_at')&&!x.created_at)x.created_at=nowIso();if(h.includes('updated_at')&&!x.updated_at)x.updated_at=nowIso();this.data[name].push(x);if(audit&&name!=='ChangeLog')await this.audit(name,x[id]||'',action,null,x);return {...x}}
  async updateById(name,id,patch,{audit=true,action='update'}={}){const f=ID_FIELD[name],i=this.data[name].findIndex(r=>String(r[f])===String(id));if(i<0)throw new Error('NOT_FOUND');const before={...this.data[name][i]};const clean={...patch};delete clean.__row;this.data[name][i]={...this.data[name][i],...clean};if(SHEETS[name]?.includes('updated_at'))this.data[name][i].updated_at=nowIso();if(audit&&name!=='ChangeLog')await this.audit(name,id,action,before,this.data[name][i]);return {...this.data[name][i]}}
  softDelete(name,id){return this.updateById(name,id,{is_deleted:true,deleted_at:nowIso()},{action:'soft_delete'})}
  restore(name,id){return this.updateById(name,id,{is_deleted:false,deleted_at:''},{action:'restore'})}
  archive(name,id,v=true){return this.updateById(name,id,{archived:v},{action:v?'archive':'unarchive'})}
  async audit(entity_type,entity_id,action,before,after){this.data.ChangeLog.push({log_id:uuid(),entity_type,entity_id,action,before_json:JSON.stringify(before),after_json:JSON.stringify(after),source:this.source,created_at:nowIso(),schema_version:5})}
  async setting(k,fallback=null){return this.settings.has(k)?this.settings.get(k):fallback}
  async setSetting(k,v){this.settings.set(k,v);return v}
  async idempotent(key,scope,fn){const old=this.data.Idempotency.find(x=>x.key===key&&x.scope===scope);if(old)return safeJsonParse(old.response_json,{});const r=await fn();this.data.Idempotency.push({idempotency_id:uuid(),key,scope,response_json:JSON.stringify(r),created_at:nowIso(),expires_at:''});return r}
  async permanentDelete(name,id){const f=ID_FIELD[name],i=this.data[name].findIndex(r=>String(r[f])===String(id));if(i<0)throw new Error('NOT_FOUND');this.data[name].splice(i,1);return true}
  async bulkUpsert(name,rows,{overwrite=false,action='bulk_restore',audit=true}={}){let inserted=0,updated=0,skipped=0;const idField=ID_FIELD[name];for(const row of rows){const id=row[idField],old=id?await this.getById(name,id):null;if(old){if(!overwrite){skipped++;continue}await this.updateById(name,id,row,{audit,action});updated++;}else{await this.insert(name,row,{audit,action});inserted++;}}return{inserted,updated,skipped};}
}

export class FakeR2 {
  constructor(){this.map=new Map()}
  async put(key,body,opt={}){let bytes;if(body instanceof ArrayBuffer)bytes=body;else if(ArrayBuffer.isView(body))bytes=body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength);else if(body instanceof Blob)bytes=await body.arrayBuffer();else bytes=new TextEncoder().encode(String(body)).buffer;this.map.set(key,{bytes,httpMetadata:opt.httpMetadata||{}});return {key}}
  async get(key){const x=this.map.get(key);if(!x)return null;return {body:x.bytes,httpMetadata:x.httpMetadata,arrayBuffer:async()=>x.bytes,size:x.bytes.byteLength}}
  async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])this.map.delete(k)}
  async list({prefix='',limit=1000}={}){const objects=[...this.map.entries()].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([key,x])=>({key,size:x.bytes.byteLength}));return{objects,truncated:false}}
}

export async function seed(repo){
  const accountA=await repo.insert('Accounts',{account_id:'acc-a',name:'ملت',type:'Card',opening_balance:0,archived:false,favorite:true},{audit:false});
  const accountB=await repo.insert('Accounts',{account_id:'acc-b',name:'نقد',type:'Cash',opening_balance:0,archived:false,favorite:false},{audit:false});
  const category=await repo.insert('Categories',{category_id:'cat-food',name:'غذا',type:'expense',archived:false,favorite:true},{audit:false});
  const person=await repo.insert('People',{person_id:'person-ali',name:'علی',archived:false,favorite:false},{audit:false});
  const project=await repo.insert('Projects',{project_id:'proj-trip',name:'سفر کیش',status:'active',archived:false},{audit:false});
  const tag=await repo.insert('Tags',{tag_id:'tag-work',name:'کاری',archived:false},{audit:false});
  const merchant=await repo.insert('Merchants',{merchant_id:'merch-snapp',name:'اسنپ',archived:false},{audit:false});
  return{accountA,accountB,category,person,project,tag,merchant};
}
