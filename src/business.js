import { SCHEMA_VERSION, bool, json, normalizeText, nowIso, parseMoney, safeJsonParse, uuid } from './utils.js';
import { formatJalali, parseDateInput } from './jalali.js';
import { ID_FIELD } from './schema.js';

export const TX_TYPES=new Set(['expense','income','transfer','installment_payment','debt','receivable','refund','adjustment']);
export const ENTITY_MAP={accounts:'Accounts',categories:'Categories',people:'People',projects:'Projects',tags:'Tags',merchants:'Merchants',rules:'Rules',templates:'Templates',installments:'Installments',debts:'Debts',recurring:'Recurring',budgets:'Budgets'};
export const ENTITY_ID={Accounts:'account_id',Categories:'category_id',People:'person_id',Projects:'project_id',Tags:'tag_id',Merchants:'merchant_id',Rules:'rule_id',Templates:'template_id',Installments:'installment_id',Debts:'debt_id',Recurring:'recurring_id',Budgets:'budget_id'};

function intMoney(value,allowZero=true){
  const n=typeof value==='number'?value:parseMoney(value);
  if(!Number.isSafeInteger(n)||n<0||(!allowZero&&n===0))throw new Error('INVALID_MONEY');
  return n;
}
function todayTehran(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
async function ensureRef(repo,sheet,id){if(!id)return null;const row=await repo.getById(sheet,id);if(!row)throw new Error('VALIDATION');return row;}
function isMissing(v){return v===undefined||v===null||v==='';}
function cashAccountRequired(type){return ['expense','income','transfer','installment_payment','receivable','refund'].includes(type);}

export class FinanceService{
  constructor(repo,actor='owner'){this.repo=repo;this.actor=actor;}

  async createTransaction(rawInput,source='manual'){
    const input=await this.applyRules({...rawInput});
    const type=String(input.type||'expense');
    if(!TX_TYPES.has(type))throw new Error('VALIDATION');
    const amount=intMoney(input.amount,false),fee=intMoney(input.fee_amount||0,true);
    const iso=parseDateInput(input.transaction_date_iso||input.transaction_date||todayTehran());

    let parent=null;
    if(type==='refund'){
      if(!input.parent_transaction_id)throw new Error('VALIDATION');
      parent=await ensureRef(this.repo,'Transactions',input.parent_transaction_id);
      if(parent.type==='refund')throw new Error('VALIDATION');
      input.account_id=input.account_id||parent.account_id;
      input.category_id=input.category_id||parent.category_id;
      input.person_id=input.person_id||parent.person_id;
      input.project_id=input.project_id||parent.project_id;
      input.merchant_id=input.merchant_id||parent.merchant_id;
      input.description=input.description||`بازپرداخت ${parent.description||''}`.trim();
    }else if(input.parent_transaction_id){
      parent=await ensureRef(this.repo,'Transactions',input.parent_transaction_id);
    }

    if(cashAccountRequired(type)&&!input.account_id)throw new Error('VALIDATION');
    if(input.account_id)await ensureRef(this.repo,'Accounts',input.account_id);
    if(input.destination_account_id)await ensureRef(this.repo,'Accounts',input.destination_account_id);
    if(type==='transfer'&&(!input.destination_account_id||input.account_id===input.destination_account_id))throw new Error('VALIDATION');
    if(input.category_id)await ensureRef(this.repo,'Categories',input.category_id);
    if(input.person_id)await ensureRef(this.repo,'People',input.person_id);
    if(input.project_id)await ensureRef(this.repo,'Projects',input.project_id);
    if(input.merchant_id)await ensureRef(this.repo,'Merchants',input.merchant_id);

    const tx={
      transaction_id:uuid(),type,amount,currency:input.currency||'TOMAN',
      transaction_date:formatJalali(iso),transaction_date_iso:iso,
      created_at:nowIso(),updated_at:nowIso(),account_id:input.account_id||'',
      destination_account_id:input.destination_account_id||'',category_id:input.category_id||'',
      person_id:input.person_id||'',project_id:input.project_id||'',merchant_id:input.merchant_id||'',
      description:String(input.description||'').trim(),note:String(input.note||'').trim(),
      fee_amount:fee,fee_note:String(input.fee_note||''),tracking_number:String(input.tracking_number||''),
      reference_number:String(input.reference_number||''),bank_transaction_id:String(input.bank_transaction_id||''),
      receipt_count:Number(input.receipt_count||0),status:input.status||'confirmed',source,
      parent_transaction_id:input.parent_transaction_id||'',is_starred:bool(input.is_starred),
      is_deleted:false,deleted_at:'',created_by:this.actor,import_batch_id:input.import_batch_id||'',
      bank_fingerprint:input.bank_fingerprint||'',metadata_json:json(input.metadata||safeJsonParse(input.metadata_json,{})),
      schema_version:SCHEMA_VERSION
    };
    const created=await this.repo.insert('Transactions',tx);
    for(const tagId of [...new Set(input.tag_ids||[])]){
      await ensureRef(this.repo,'Tags',tagId);
      await this.repo.insert('EntityTags',{entity_tag_id:uuid(),entity_type:'transaction',entity_id:created.transaction_id,tag_id:tagId,created_at:nowIso(),schema_version:SCHEMA_VERSION});
    }
    if(parent)await this.link('transaction',parent.transaction_id,'transaction',created.transaction_id,type==='refund'?'refund':'linked');
    return created;
  }

  async editTransaction(id,patch){
    const before=await this.repo.getById('Transactions',id);if(!before)throw new Error('NOT_FOUND');
    const clean={...patch};
    if(clean.amount!==undefined)clean.amount=intMoney(clean.amount,false);
    if(clean.fee_amount!==undefined)clean.fee_amount=intMoney(clean.fee_amount);
    if(clean.transaction_date!==undefined||clean.transaction_date_iso!==undefined){const iso=parseDateInput(clean.transaction_date_iso||clean.transaction_date);clean.transaction_date_iso=iso;clean.transaction_date=formatJalali(iso);}
    if(clean.type!==undefined&&!TX_TYPES.has(clean.type))throw new Error('VALIDATION');
    if(clean.type!==undefined&&clean.type!==before.type)throw new Error('VALIDATION');
    for(const [field,sheet] of [['account_id','Accounts'],['destination_account_id','Accounts'],['category_id','Categories'],['person_id','People'],['project_id','Projects'],['merchant_id','Merchants'],['parent_transaction_id','Transactions']])if(clean[field])await ensureRef(this.repo,sheet,clean[field]);
    if((clean.type||before.type)==='transfer'&&String(clean.account_id??before.account_id)===String(clean.destination_account_id??before.destination_account_id))throw new Error('VALIDATION');
    return this.repo.updateById('Transactions',id,clean);
  }
  async softDeleteTransaction(id){const tx=await this.repo.getById('Transactions',id);if(!tx)throw new Error('NOT_FOUND');const deleted=await this.repo.softDelete('Transactions',id);await this.reconcileLinkedAggregates(id,false);return deleted;}
  async restoreTransaction(id){const tx=await this.repo.getById('Transactions',id);if(!tx)throw new Error('NOT_FOUND');const restored=await this.repo.restore('Transactions',id);await this.reconcileLinkedAggregates(id,true);return restored;}
  async reconcileLinkedAggregates(transactionId,restoring=true){
    const [debtPayments,installmentPayments,links]=await Promise.all([this.repo.list('DebtPayments',{limit:10000,filter:x=>x.transaction_id===transactionId}),this.repo.list('InstallmentPayments',{limit:10000,filter:x=>x.transaction_id===transactionId}),this.repo.list('Links',{limit:10000,filter:x=>x.from_type==='transaction'&&x.from_id===transactionId&&x.to_type==='debt'&&x.relation==='origin'})]);
    for(const p of debtPayments)await this.recalculateDebt(p.debt_id);for(const p of installmentPayments)await this.recalculateInstallment(p.installment_id);for(const link of links){if(restoring)await this.recalculateDebt(link.to_id);else await this.repo.updateById('Debts',link.to_id,{status:'void'});}
  }
  async recalculateDebt(debtId){const d=await ensureRef(this.repo,'Debts',debtId),payments=await this.repo.list('DebtPayments',{limit:10000,filter:x=>x.debt_id===debtId}),txs=await this.repo.list('Transactions',{limit:20000});const byId=new Map(txs.map(x=>[x.transaction_id,x])),settled=payments.reduce((sum,p)=>{const tx=byId.get(p.transaction_id);return sum+((tx&&!bool(tx.is_deleted)&&String(tx.status||'confirmed')==='confirmed')?Number(p.amount||0):0)},0),status=settled>=Number(d.principal_amount||0)?'settled':settled>0?'partial':'open';await this.repo.updateById('Debts',debtId,{settled_amount:settled,status});return{...d,settled_amount:settled,status};}
  async recalculateInstallment(installmentId){const plan=await ensureRef(this.repo,'Installments',installmentId),payments=await this.repo.list('InstallmentPayments',{limit:10000,filter:x=>x.installment_id===installmentId}),txs=await this.repo.list('Transactions',{limit:20000}),byId=new Map(txs.map(x=>[x.transaction_id,x])),paid=payments.reduce((sum,p)=>{const tx=byId.get(p.transaction_id);return sum+((tx&&!bool(tx.is_deleted)&&String(tx.status||'confirmed')==='confirmed')?Number(p.amount||0):0)},0),status=paid>=Number(plan.total_amount||0)?'completed':'active';if(plan.status!==status)await this.repo.updateById('Installments',installmentId,{status});return{...plan,paid,status};}

  async accountBalances(accountIds=null){
    const accounts=await this.repo.list('Accounts',{limit:1000});
    const wanted=accountIds?new Set(accountIds.map(String)):null;
    const balances=new Map(accounts.filter(a=>!wanted||wanted.has(String(a.account_id))).map(a=>[String(a.account_id),Number(a.opening_balance||0)]));
    const txs=await this.repo.list('Transactions',{limit:20000,includeDeleted:false});
    const add=(id,delta)=>{id=String(id||'');if(balances.has(id))balances.set(id,balances.get(id)+delta);};
    for(const t of txs.filter(x=>String(x.status||'confirmed')==='confirmed')){
      const a=Number(t.amount||0),f=Number(t.fee_amount||0),meta=safeJsonParse(t.metadata_json,{});
      if(t.type==='income')add(t.account_id,a);
      else if(t.type==='expense')add(t.account_id,-a-f);
      else if(t.type==='transfer'){add(t.account_id,-a-f);add(t.destination_account_id,a);}
      else if(t.type==='installment_payment'||t.type==='receivable')add(t.account_id,-a-f);
      else if(t.type==='refund')add(t.account_id,a-f);
      else if(t.type==='debt')add(t.account_id,meta.direction==='settlement'?-a-f:(t.account_id?a:0));
      else if(t.type==='adjustment')add(t.account_id,Number(meta.delta??a));
    }
    return Object.fromEntries(balances);
  }
  async accountBalance(accountId){await ensureRef(this.repo,'Accounts',accountId);return Number((await this.accountBalances([accountId]))[String(accountId)]||0);}

  async createReceivable({person_id,amount,account_id,project_id='',description='',note='',date,fee_amount=0,source='manual',due_date=''}){
    await ensureRef(this.repo,'People',person_id);
    const tx=await this.createTransaction({type:'receivable',person_id,amount,account_id,project_id,description,note,transaction_date:date,fee_amount},source);
    const debt=await this.repo.insert('Debts',{debt_id:uuid(),kind:'receivable',person_id,principal_amount:tx.amount,settled_amount:0,status:'open',due_date:due_date?parseDateInput(due_date):'',note,project_id,created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});
    await this.link('transaction',tx.transaction_id,'debt',debt.debt_id,'origin');return{transaction:tx,debt};
  }
  async createDebt({person_id,amount,account_id='',project_id='',description='',note='',date,source='manual',due_date=''}){
    await ensureRef(this.repo,'People',person_id);
    const tx=await this.createTransaction({type:'debt',person_id,amount,account_id,project_id,description,note,transaction_date:date,metadata:{direction:'origin'}},source);
    const debt=await this.repo.insert('Debts',{debt_id:uuid(),kind:'debt',person_id,principal_amount:tx.amount,settled_amount:0,status:'open',due_date:due_date?parseDateInput(due_date):'',note,project_id,created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION});
    await this.link('transaction',tx.transaction_id,'debt',debt.debt_id,'origin');return{transaction:tx,debt};
  }
  async settleDebt(debtId,{amount,account_id,fee_amount=0,note='',date,source='manual'}){
    let d=await ensureRef(this.repo,'Debts',debtId);d=await this.recalculateDebt(debtId);const value=intMoney(amount,false),remaining=Number(d.principal_amount||0)-Number(d.settled_amount||0);if(value>remaining)throw new Error('VALIDATION');
    const type=d.kind==='receivable'?'income':'debt',metadata=d.kind==='receivable'?{debt_settlement:true,direction:'settlement'}:{direction:'settlement'};
    const tx=await this.createTransaction({type,amount:value,account_id,person_id:d.person_id,project_id:d.project_id,fee_amount,note,transaction_date:date,metadata},source);
    const payment=await this.repo.insert('DebtPayments',{payment_id:uuid(),debt_id:debtId,transaction_id:tx.transaction_id,amount:value,fee_amount:intMoney(fee_amount),payment_date:tx.transaction_date_iso,account_id,note,created_at:nowIso(),schema_version:SCHEMA_VERSION});
    const settled=Number(d.settled_amount||0)+value;await this.repo.updateById('Debts',debtId,{settled_amount:settled,status:settled>=Number(d.principal_amount)?'settled':'partial'});await this.link('debt',debtId,'transaction',tx.transaction_id,'settlement');return{transaction:tx,payment};
  }
  async payInstallment(installmentId,{amount,fee_amount=0,account_id,date,note='',source='installment'}){
    const plan=await ensureRef(this.repo,'Installments',installmentId),value=intMoney(amount||plan.default_installment_amount,false);
    const tx=await this.createTransaction({type:'installment_payment',amount:value,fee_amount,account_id:account_id||plan.account_id,person_id:plan.person_id,project_id:plan.project_id,category_id:'',description:plan.title,note,transaction_date:date,metadata:{installment_id:installmentId}},source);
    const payment=await this.repo.insert('InstallmentPayments',{payment_id:uuid(),installment_id:installmentId,transaction_id:tx.transaction_id,amount:value,fee_amount:intMoney(fee_amount),payment_date:tx.transaction_date_iso,note,created_at:nowIso(),schema_version:SCHEMA_VERSION});
    const recalculated=await this.recalculateInstallment(installmentId),paid=recalculated.paid;
    await this.link('installment',installmentId,'transaction',tx.transaction_id,'payment');return{transaction:tx,payment,paid};
  }
  async installmentSummary(id){
    const plan=await ensureRef(this.repo,'Installments',id),allPayments=await this.repo.list('InstallmentPayments',{limit:5000,filter:x=>x.installment_id===id}),txs=await this.repo.list('Transactions',{limit:20000}),byId=new Map(txs.map(x=>[x.transaction_id,x])),payments=allPayments.filter(p=>{const tx=byId.get(p.transaction_id);return tx&&!bool(tx.is_deleted)&&String(tx.status||'confirmed')==='confirmed'});
    const paid=payments.reduce((s,x)=>s+Number(x.amount||0),0),fees=payments.reduce((s,x)=>s+Number(x.fee_amount||0),0);return{plan:{...plan,status:paid>=Number(plan.total_amount||0)?'completed':plan.status==='overdue'?'overdue':'active'},payments,paid,fees,remaining:Math.max(0,Number(plan.total_amount||0)-paid),payment_count:payments.length};
  }

  async merge(sheet,primaryId,duplicateId){
    const idField=ENTITY_ID[sheet];if(!idField||primaryId===duplicateId)throw new Error('VALIDATION');
    const primary=await ensureRef(this.repo,sheet,primaryId),duplicate=await ensureRef(this.repo,sheet,duplicateId),refField={People:'person_id',Categories:'category_id',Merchants:'merchant_id',Projects:'project_id',Accounts:'account_id',Tags:'tag_id'}[sheet];if(!refField)throw new Error('VALIDATION');
    let count=0;
    for(const target of ['Transactions','Debts','Installments','Recurring','Budgets']){
      const headers=await this.repo.headers(target);if(!headers.includes(refField))continue;
      const rows=await this.repo.list(target,{limit:20000});for(const row of rows.filter(x=>x[refField]===duplicateId)){await this.repo.updateById(target,row[ID_FIELD[target]],{[refField]:primaryId},{action:'merge_repoint'});count++;}
    }
    if(sheet==='Accounts'){
      const txs=await this.repo.list('Transactions',{limit:20000,filter:x=>x.destination_account_id===duplicateId});for(const tx of txs){await this.repo.updateById('Transactions',tx.transaction_id,{destination_account_id:primaryId},{action:'merge_repoint'});count++;}
    }
    if(sheet==='Tags'){
      const joins=await this.repo.list('EntityTags',{limit:20000,filter:x=>x.tag_id===duplicateId});for(const j of joins){const duplicateJoin=await this.repo.findOne('EntityTags',x=>x.tag_id===primaryId&&x.entity_type===j.entity_type&&x.entity_id===j.entity_id);if(duplicateJoin)await this.repo.permanentDelete('EntityTags',j.entity_tag_id);else await this.repo.updateById('EntityTags',j.entity_tag_id,{tag_id:primaryId},{action:'merge_repoint'});count++;}
    }
    await this.repo.archive(sheet,duplicateId,true);await this.repo.audit(sheet,primaryId,'merge',primary,{...primary,merged_from:duplicateId});return{primary,duplicate,affected_count:count};
  }
  async link(fromType,fromId,toType,toId,relation,metadata={}){return this.repo.insert('Links',{link_id:uuid(),from_type:fromType,from_id:fromId,to_type:toType,to_id:toId,relation,metadata_json:json(metadata),created_at:nowIso(),schema_version:SCHEMA_VERSION});}

  async applyRules(input){
    const rules=await this.repo.list('Rules',{limit:1000,filter:r=>String(r.enabled)!=='false'});rules.sort((a,b)=>Number(b.priority||0)-Number(a.priority||0));let out={...input};
    for(const rule of rules){
      const conditions=safeJsonParse(rule.conditions_json,{}),actions=safeJsonParse(rule.actions_json,{}),text=normalizeText([out.description,out.merchant_name,out.reference_number,out.tracking_number].filter(Boolean).join(' '));let match=true;
      if(conditions.description_contains)match=match&&text.includes(normalizeText(conditions.description_contains));
      if(conditions.description_regex){try{match=match&&new RegExp(conditions.description_regex,'i').test(text)}catch{match=false}}
      if(conditions.account_id)match=match&&out.account_id===conditions.account_id;
      if(conditions.type)match=match&&out.type===conditions.type;
      if(match)for(const [key,value] of Object.entries(actions))if(isMissing(out[key]))out[key]=value;
    }
    return out;
  }
}

export function calculateSplit({total_amount,mode='equal',items}){
  const total=intMoney(total_amount,false);if(!Array.isArray(items)||items.length<2)throw new Error('VALIDATION');
  const rows=items.map((x,i)=>({index:i,person_id:x.person_id||'',name:x.name||`نفر ${i+1}`,paid_amount:intMoney(x.paid_amount||0),share_value:Number(x.share_value??1)}));let shares=[];
  if(mode==='equal'){const base=Math.floor(total/rows.length),remainder=total-base*rows.length;shares=rows.map((_,i)=>base+(i<remainder?1:0));}
  else if(mode==='weighted'){const weights=rows.reduce((s,x)=>s+x.share_value,0);if(weights<=0)throw new Error('VALIDATION');let assigned=0;shares=rows.map((x,i)=>{if(i===rows.length-1)return total-assigned;const value=Math.floor(total*x.share_value/weights);assigned+=value;return value;});}
  else if(mode==='custom'){shares=rows.map(x=>intMoney(x.share_value));if(shares.reduce((a,b)=>a+b,0)!==total)throw new Error('VALIDATION');}
  else throw new Error('VALIDATION');
  const result=rows.map((x,i)=>({...x,share_amount:shares[i],balance:x.paid_amount-shares[i]}));
  const creditors=result.filter(x=>x.balance>0).map(x=>({...x,left:x.balance})),debtors=result.filter(x=>x.balance<0).map(x=>({...x,left:-x.balance})),settlements=[];
  for(const debtor of debtors)for(const creditor of creditors){if(!debtor.left)break;if(!creditor.left)continue;const amount=Math.min(debtor.left,creditor.left);settlements.push({from:{person_id:debtor.person_id,name:debtor.name},to:{person_id:creditor.person_id,name:creditor.name},amount});debtor.left-=amount;creditor.left-=amount;}
  return{total_amount:total,mode,items:result,settlements};
}
