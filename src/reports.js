import { bool, normalizeText, safeJsonParse } from './utils.js';
import { formatJalali, jalaliMonthRange } from './jalali.js';

function inRange(t,from,to){const d=String(t.transaction_date_iso||'');return(!from||d>=from)&&(!to||d<=to);}
function confirmed(t){return String(t.status||'confirmed')==='confirmed';}

export async function lookupMaps(repo){
  const defs=[['Accounts','account_id','accounts'],['Categories','category_id','categories'],['People','person_id','people'],['Projects','project_id','projects'],['Merchants','merchant_id','merchants'],['Tags','tag_id','tags']];
  const out={};for(const [sheet,id,key]of defs){const rows=await repo.list(sheet,{limit:5000});out[key]=Object.fromEntries(rows.map(r=>[r[id],r.name||r.title||'']));}return out;
}

export async function queryTransactions(repo,filters={}){
  let txs=await repo.list('Transactions',{limit:20000,includeDeleted:false});
  txs=txs.filter(t=>confirmed(t)&&inRange(t,filters.from,filters.to));
  const eq=['type','account_id','category_id','person_id','project_id','merchant_id','source','status'];for(const key of eq)if(filters[key])txs=txs.filter(t=>String(t[key])===String(filters[key]));
  if(filters.starred!==undefined)txs=txs.filter(t=>bool(t.is_starred)===bool(filters.starred));
  if(filters.has_fee)txs=txs.filter(t=>Number(t.fee_amount||0)>0);
  if(filters.has_receipt)txs=txs.filter(t=>Number(t.receipt_count||0)>0);
  if(filters.installment)txs=txs.filter(t=>t.type==='installment_payment'||safeJsonParse(t.metadata_json,{})?.installment_id);
  if(filters.debt_receivable)txs=txs.filter(t=>['debt','receivable'].includes(t.type)||safeJsonParse(t.metadata_json,{})?.debt_settlement);
  if(filters.min_amount!==undefined)txs=txs.filter(t=>Number(t.amount||0)>=Number(filters.min_amount));
  if(filters.max_amount!==undefined)txs=txs.filter(t=>Number(t.amount||0)<=Number(filters.max_amount));

  let tagNamesByTx={};
  if(filters.tag_id||filters.q){
    const [joins,tags]=await Promise.all([repo.list('EntityTags',{limit:20000,filter:x=>x.entity_type==='transaction'}),repo.list('Tags',{limit:5000})]);
    const names=Object.fromEntries(tags.map(x=>[x.tag_id,x.name]));
    for(const j of joins)(tagNamesByTx[j.entity_id]??=[]).push(names[j.tag_id]||'');
    if(filters.tag_id){const ids=new Set(joins.filter(x=>x.tag_id===filters.tag_id).map(x=>x.entity_id));txs=txs.filter(t=>ids.has(t.transaction_id));}
  }
  if(filters.q){
    const q=normalizeText(filters.q),maps=await lookupMaps(repo);
    txs=txs.filter(t=>normalizeText([t.amount,t.description,t.note,t.tracking_number,t.reference_number,t.bank_transaction_id,maps.people[t.person_id],maps.merchants[t.merchant_id],maps.projects[t.project_id],maps.categories[t.category_id],...(tagNamesByTx[t.transaction_id]||[])].join(' ')).includes(q));
  }
  txs.sort((a,b)=>String(b.transaction_date_iso).localeCompare(String(a.transaction_date_iso))||String(b.created_at).localeCompare(String(a.created_at)));return txs;
}

export function summarize(txs){
  let expense=0,income=0,fees=0,refunds=0,outflow=0,inflow=0,transfers=0,receivables_created=0,debt_settlements=0;
  const byCategory={},daily={};
  for(const t of txs){
    const amount=Number(t.amount||0),fee=Number(t.fee_amount||0),meta=safeJsonParse(t.metadata_json,{});fees+=fee;
    if(t.type==='expense'||t.type==='installment_payment'){
      expense+=amount;outflow+=amount+fee;byCategory[t.category_id||'بدون دسته']=(byCategory[t.category_id||'بدون دسته']||0)+amount;daily[t.transaction_date_iso]=(daily[t.transaction_date_iso]||0)+amount;
    }else if(t.type==='income'){
      inflow+=amount;if(!meta.debt_settlement)income+=amount;
    }else if(t.type==='refund'){
      refunds+=amount;inflow+=amount;outflow+=fee;
    }else if(t.type==='transfer'){
      transfers+=amount;outflow+=fee;
    }else if(t.type==='receivable'){
      receivables_created+=amount;outflow+=amount+fee;
    }else if(t.type==='debt'&&meta.direction==='settlement'){
      debt_settlements+=amount;outflow+=amount+fee;
    }else if(t.type==='debt'&&meta.direction==='origin'&&t.account_id){
      inflow+=amount;
    }
  }
  const netExpense=expense-refunds;
  return{expense,income,fees,refunds,net_expense:netExpense,net:income-netExpense-fees,outflow,inflow,transfers,receivables_created,debt_settlements,by_category:byCategory,daily};
}

export async function report(repo,{from,to,...filters}={}){
  const txs=await queryTransactions(repo,{from,to,...filters}),summary=summarize(txs),maps=await lookupMaps(repo);
  const categories=Object.entries(summary.by_category).map(([id,amount])=>({category_id:id,name:maps.categories[id]||'بدون دسته',amount})).sort((a,b)=>b.amount-a.amount);
  return{from,to,summary:{...summary,by_category:undefined},categories,transactions:txs};
}
export async function currentMonthReport(repo){const range=jalaliMonthRange();return report(repo,{from:range.start,to:range.end});}
export async function comparePeriods(repo,a,b){const [current,previous]=await Promise.all([report(repo,a),report(repo,b)]),pct=(x,y)=>y===0?null:Math.round(((x-y)/Math.abs(y))*1000)/10;return{current,previous,change:{expense_pct:pct(current.summary.net_expense,previous.summary.net_expense),income_pct:pct(current.summary.income,previous.summary.income),fees_pct:pct(current.summary.fees,previous.summary.fees)}};}

function budgetApplies(budget,range){
  const p=String(budget.period||'monthly').trim().toLowerCase();if(!p||p==='monthly'||p==='ماهانه')return true;
  if(/^\d{4}-\d{2}$/.test(p))return range.start.startsWith(p);
  const j=formatJalali(range.start).slice(0,7);return p===j;
}
export async function budgetProgress(repo,range,txs){
  const budgets=await repo.list('Budgets',{limit:1000,filter:x=>String(x.active)!=='false'&&budgetApplies(x,range)}),defaults=await repo.setting('budget_thresholds',[80,90,100]),items=[];
  for(const b of budgets){
    let selected=txs;if(b.scope_type==='category')selected=txs.filter(t=>t.category_id===b.scope_id);else if(b.scope_type==='project')selected=txs.filter(t=>t.project_id===b.scope_id);
    const used=summarize(selected).net_expense,amount=Number(b.amount||0),percent=amount>0?Math.round(used*1000/amount)/10:0,thresholds=safeJsonParse(b.warning_thresholds_json,defaults);
    items.push({...b,used,remaining:Math.max(0,amount-used),percent,thresholds,level:percent>=100?'danger':percent>=Number(thresholds?.[1]??90)?'high':percent>=Number(thresholds?.[0]??80)?'warning':'ok'});
  }
  return items;
}

export async function dashboard(repo,finance){
  const period=jalaliMonthRange(),rep=await report(repo,{from:period.start,to:period.end}),accounts=await repo.list('Accounts',{limit:500,filter:x=>String(x.archived)!=='true'}),balanceMap=await finance.accountBalances(accounts.map(a=>a.account_id));
  const installments=await repo.list('Installments',{limit:500,filter:x=>x.status!=='completed'&&String(x.archived)!=='true'}),debts=await repo.list('Debts',{limit:2000,filter:x=>x.kind==='receivable'&&x.status!=='settled'}),inbox=await repo.list('Inbox',{limit:2000,filter:x=>x.status==='pending'});
  const outstanding=debts.reduce((s,d)=>s+Math.max(0,Number(d.principal_amount||0)-Number(d.settled_amount||0)),0),budgets=await budgetProgress(repo,period,rep.transactions);
  return{period,summary:rep.summary,categories:rep.categories.slice(0,8),recent:rep.transactions.slice(0,12),accounts:accounts.map(a=>({...a,balance:Number(balanceMap[a.account_id]||0)})),upcoming_installments:installments.sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date))).slice(0,5),outstanding_receivables:outstanding,inbox_count:inbox.length,budgets};
}

export async function personSummary(repo,personId){
  const txs=await queryTransactions(repo,{person_id:personId}),debts=await repo.list('Debts',{limit:5000,filter:x=>x.person_id===personId});let spent=0,received=0,receivable=0,debt=0;
  for(const t of txs){const meta=safeJsonParse(t.metadata_json,{});if(t.type==='expense'||t.type==='receivable')spent+=Number(t.amount||0);if(t.type==='income')received+=Number(t.amount||0);}
  for(const d of debts){const rem=Math.max(0,Number(d.principal_amount||0)-Number(d.settled_amount||0));if(d.kind==='receivable')receivable+=rem;else debt+=rem;}
  return{spent,received,receivable,debt,balance:receivable-debt,transactions:txs,debts};
}

export async function projectSummary(repo,projectId){
  const project=await repo.getById('Projects',projectId);if(!project)throw new Error('NOT_FOUND');const txs=await queryTransactions(repo,{project_id:projectId}),summary=summarize(txs),ids=new Set(txs.map(t=>t.transaction_id));
  const [receipts,splits,joins,tags,people]=await Promise.all([repo.list('Receipts',{limit:10000,filter:r=>ids.has(r.transaction_id)}),repo.list('Splits',{limit:2000,filter:x=>x.project_id===projectId}),repo.list('EntityTags',{limit:20000,filter:x=>x.entity_type==='transaction'&&ids.has(x.entity_id)}),repo.list('Tags',{limit:5000}),repo.list('People',{limit:5000})]);
  const tagMap=Object.fromEntries(tags.map(t=>[t.tag_id,t])),personMap=Object.fromEntries(people.map(p=>[p.person_id,p])),tagIds=[...new Set(joins.map(j=>j.tag_id))],personIds=[...new Set(txs.map(t=>t.person_id).filter(Boolean))];
  const budget=Number(project.budget||0),used=summary.net_expense;return{project,...summary,transactions:txs,receipt_count:receipts.length,receipts,splits,tags:tagIds.map(id=>tagMap[id]).filter(Boolean),people:personIds.map(id=>personMap[id]).filter(Boolean),budget:{amount:budget,used,remaining:budget?Math.max(0,budget-used):null,percent:budget?Math.round(used*1000/budget)/10:null}};
}
