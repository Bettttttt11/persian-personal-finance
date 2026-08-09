import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepo, FakeR2, seed } from './helper.js';
import { FinanceService, calculateSplit } from '../src/business.js';
import { queryTransactions, report, dashboard } from '../src/reports.js';
import { parseDateInput, formatJalali } from '../src/jalali.js';
import { previewImport, confirmImport, rowsFromCsv } from '../src/imports.js';
import { saveReceipt } from '../src/storage.js';
import { verifyPin, createSession, authenticateMiniApi, validateTelegramInitData } from '../src/auth.js';
import { hmac, hmacHex } from '../src/utils.js';
import { handleAiText, confirmAiActions } from '../src/ai.js';
import { createBackup, previewRestore, applyRestore } from '../src/backup.js';
import { nextOccurrence } from '../src/recurrence.js';
import { undoLast } from '../src/audit.js';
import { telegramAccessPolicy } from '../src/telegram.js';

test('/start and unauthorized Telegram access policy',()=>{
  assert.equal(telegramAccessPolicy('10','99',false,'/start'),'denied');
  assert.equal(telegramAccessPolicy('10','10',false,'/start'),'ask_pin');
  assert.equal(telegramAccessPolicy('10','10',true,'/start'),'allowed');
});

test('PIN wrong, PIN correct, Mini App initData and session auth',async()=>{
  const env={BOT_PIN:'2468',SESSION_SECRET:'0123456789abcdef0123456789abcdef',TELEGRAM_BOT_TOKEN:'123456:TESTTOKEN',OWNER_TELEGRAM_ID:'42'};const repo=new MemoryRepo(env);
  await assert.rejects(()=>verifyPin(repo,env,'42','1111'),/PIN_WRONG/);
  assert.equal(await verifyPin(repo,env,'42','2468'),true);
  const user=JSON.stringify({id:42,first_name:'مالک'}),auth_date=String(Math.floor(Date.now()/1000));const p=new URLSearchParams({auth_date,query_id:'AAE',user});const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const secret=await hmac('WebAppData',env.TELEGRAM_BOT_TOKEN);p.set('hash',await hmacHex(secret,check,true));const initData=p.toString();
  assert.equal((await validateTelegramInitData(initData,env.TELEGRAM_BOT_TOKEN,'42')).id,42);
  const s=await createSession(repo,'42','mini_app','1h');const req=new Request('https://x/api/dashboard',{headers:{'x-telegram-init-data':initData,'cookie':`pf_session=${s.token}`}});const a=await authenticateMiniApi(req,repo,env);assert.equal(String(a.user.id),'42');
});

test('create expense, income, transfer, fee and account balances',async()=>{
  const repo=new MemoryRepo();const x=await seed(repo),f=new FinanceService(repo);
  await f.createTransaction({type:'expense',amount:100000,fee_amount:2000,account_id:x.accountA.account_id,category_id:x.category.category_id,transaction_date:'1405/05/18',description:'ناهار'},'telegram');
  await f.createTransaction({type:'income',amount:300000,account_id:x.accountA.account_id,transaction_date:'2026/08/09',description:'حقوق'},'mini_app');
  await f.createTransaction({type:'transfer',amount:50000,fee_amount:1000,account_id:x.accountA.account_id,destination_account_id:x.accountB.account_id,transaction_date:'امروز',description:'انتقال'},'mini_app');
  assert.equal(await f.accountBalance('acc-a'),147000);assert.equal(await f.accountBalance('acc-b'),50000);
  assert.equal(parseDateInput('1405/05/18'),'2026-08-09');assert.equal(formatJalali('2026-08-09'),'1405/05/18');
});

test('person receivable, installment fee, edit, soft delete and restore',async()=>{
  const repo=new MemoryRepo();const x=await seed(repo),f=new FinanceService(repo);
  const r=await f.createReceivable({person_id:x.person.person_id,amount:800000,account_id:x.accountA.account_id,project_id:x.project.project_id,description:'خرید برای علی',date:'2026-08-09',fee_amount:5000});assert.equal(r.transaction.type,'receivable');assert.equal(r.debt.kind,'receivable');
  await repo.insert('Installments',{installment_id:'inst-1',title:'لپ‌تاپ',total_amount:4000000,installment_count:2,default_installment_amount:2000000,start_date:'2026-08-01',due_day:10,account_id:'acc-a',person_id:'',project_id:'proj-trip',status:'active'},{audit:false});
  const p=await f.payInstallment('inst-1',{amount:2000000,fee_amount:15000,account_id:'acc-a',date:'2026-08-09'});assert.equal(p.transaction.fee_amount,15000);const sm=await f.installmentSummary('inst-1');assert.equal(sm.paid,2000000);assert.equal(sm.fees,15000);
  const e=await f.editTransaction(p.transaction.transaction_id,{note:'پرداخت اول'});assert.equal(e.note,'پرداخت اول');await f.softDeleteTransaction(e.transaction_id);assert.equal((await repo.getById('Transactions',e.transaction_id)).is_deleted,true);await f.restoreTransaction(e.transaction_id);assert.equal((await repo.getById('Transactions',e.transaction_id)).is_deleted,false);
});

test('search, filters, reports, project and tag relations',async()=>{
  const repo=new MemoryRepo();const x=await seed(repo),f=new FinanceService(repo);
  await f.createTransaction({type:'expense',amount:420000,account_id:'acc-a',category_id:'cat-food',project_id:'proj-trip',merchant_id:'merch-snapp',tag_ids:['tag-work'],transaction_date:'2026-08-09',description:'ناهار کاری'},'telegram');
  await f.createTransaction({type:'income',amount:1000000,account_id:'acc-a',transaction_date:'2026-08-09',description:'درآمد'},'telegram');
  assert.equal((await queryTransactions(repo,{q:'ناهار'})).length,1);assert.equal((await queryTransactions(repo,{project_id:'proj-trip',tag_id:'tag-work'})).length,1);const rep=await report(repo,{from:'2026-08-01',to:'2026-08-31'});assert.equal(rep.summary.expense,420000);assert.equal(rep.summary.income,1000000);
});

test('receipt storage in private R2 binding',async()=>{
  const env={RECEIPTS_BUCKET:new FakeR2()};const repo=new MemoryRepo(env);await seed(repo);const f=new FinanceService(repo);const tx=await f.createTransaction({type:'expense',amount:1000,account_id:'acc-a',transaction_date:'2026-08-09',description:'فیش'});const bytes=new Uint8Array([1,2,3,4]).buffer,thumb=new Uint8Array([5,6]).buffer;const r=await saveReceipt(repo,env,{transaction_id:tx.transaction_id,bytes,mime_type:'image/webp',thumbBytes:thumb});assert.match(r.object_key,/receipt\.webp$/);assert.equal((await repo.getById('Transactions',tx.transaction_id)).receipt_count,1);assert.ok(await env.RECEIPTS_BUCKET.get(r.object_key));
});

test('bank CSV/import duplicate detection and reconciliation with manual transaction',async()=>{
  const repo=new MemoryRepo();await seed(repo);const f=new FinanceService(repo);const manual=await f.createTransaction({type:'expense',amount:420000,account_id:'acc-a',transaction_date:'2026-08-09',description:'ناهار رستوران'});const p=await previewImport(repo,{file_name:'bank.csv',account_id:'acc-a',rows:[{row_index:2,date:'2026-08-09',amount:'420000',description:'ناهار رستوران پرداخت کارت'}]});assert.equal(p.counts.suspect,1);const suspect=p.items[0];const c=await confirmImport(repo,f,p.import.import_id,{[suspect.item_id]:'link'});assert.deepEqual(c.linked,[manual.transaction_id]);assert.equal((await repo.list('Transactions')).length,1);
  const bank=await f.createTransaction({type:'expense',amount:9000,account_id:'acc-a',transaction_date:'2026-08-09',description:'بانک',bank_transaction_id:'B-1'});const p2=await previewImport(repo,{file_name:'b.csv',account_id:'acc-a',rows:[{date:'2026-08-09',amount:'9000',description:'بانک',bank_transaction_id:'B-1'}]});assert.equal(p2.counts.duplicate,1);
});

test('AI read question, AI create proposal and confirmation',async()=>{
  const env={OPENROUTER_API_KEY:'key',OPENROUTER_TEXT_MODEL:'test/text',OWNER_TELEGRAM_ID:'42',PUBLIC_BASE_URL:'https://finance.example'};const repo=new MemoryRepo(env);await seed(repo);const f=new FinanceService(repo);await f.createTransaction({type:'expense',amount:123000,account_id:'acc-a',transaction_date:'2026-08-09',description:'ناهار'});
  const old=globalThis.fetch;globalThis.fetch=async(url,opt={})=>{url=String(url);if(url.includes('/models'))return new Response(JSON.stringify({data:[{id:'test/text',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['structured_outputs']}]}),{status:200,headers:{'content-type':'application/json'}});if(url.includes('/chat/completions')){const b=JSON.parse(opt.body);const all=JSON.stringify(b.messages);if(all.includes('پاسخ فارسی کوتاه'))return new Response(JSON.stringify({choices:[{message:{content:'خرج ثبت‌شده ۱۲۳٬۰۰۰ تومان است.'}}]}),{status:200,headers:{'content-type':'application/json'}});if(all.includes('این ماه چه خرج'))return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'read',read:{metric:'summary'}})}}]}),{status:200,headers:{'content-type':'application/json'}});if(all.includes('امروز 350000 ناهار'))return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'actions',actions:[{action:'create_transaction',data:{type:'expense',amount:350000,account_id:'acc-a',transaction_date:'2026-08-09',description:'ناهار'}}]})}}]}),{status:200,headers:{'content-type':'application/json'}});return new Response(JSON.stringify({choices:[{message:{content:'خرج ثبت‌شده ۱۲۳٬۰۰۰ تومان است.'}}]}),{status:200,headers:{'content-type':'application/json'}})}throw new Error('unexpected fetch')};
  try{const read=await handleAiText(repo,env,'این ماه چه خرج کردم؟');assert.equal(read.kind,'read');assert.match(read.text,/۱۲۳|خرج/);const prop=await handleAiText(repo,env,'امروز 350000 ناهار دادم');assert.equal(prop.kind,'actions');assert.equal(prop.actions.length,1);await confirmAiActions(repo,f,prop.draft_id);const tx=await queryTransactions(repo,{q:'ناهار'});assert.equal(tx.length,2);}finally{globalThis.fetch=old}
});

test('deterministic Dangi calculation',()=>{const d=calculateSplit({total_amount:1200000,mode:'equal',items:[{name:'من',paid_amount:800000},{name:'علی',paid_amount:400000},{name:'رضا',paid_amount:0}]});assert.deepEqual(d.items.map(x=>x.share_amount),[400000,400000,400000]);assert.equal(d.settlements.length,1);assert.equal(d.settlements[0].from.name,'رضا');assert.equal(d.settlements[0].to.name,'من');assert.equal(d.settlements[0].amount,400000)});

test('Mini App dashboard data is computed from real repository data',async()=>{const repo=new MemoryRepo();await seed(repo);const f=new FinanceService(repo);await f.createTransaction({type:'expense',amount:250000,fee_amount:5000,account_id:'acc-a',transaction_date:new Date().toISOString().slice(0,10),description:'خرید'});const d=await dashboard(repo,f);assert.ok(Array.isArray(d.accounts));assert.ok('expense'in d.summary);assert.equal(d.inbox_count,0)});


test('PIN lockout and signed session cookie tampering are rejected',async()=>{
  const env={BOT_PIN:'2468',SESSION_SECRET:'0123456789abcdef0123456789abcdef',TELEGRAM_BOT_TOKEN:'123456:TESTTOKEN',OWNER_TELEGRAM_ID:'42'},repo=new MemoryRepo(env);
  for(let i=0;i<4;i++)await assert.rejects(()=>verifyPin(repo,env,'42','0000'),/PIN_WRONG/);
  await assert.rejects(()=>verifyPin(repo,env,'42','0000'),/PIN_LOCKED/);await assert.rejects(()=>verifyPin(repo,env,'42','2468'),/PIN_LOCKED/);
  const user=JSON.stringify({id:42}),auth_date=String(Math.floor(Date.now()/1000)),p=new URLSearchParams({auth_date,user}),check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n'),secret=await hmac('WebAppData',env.TELEGRAM_BOT_TOKEN);p.set('hash',await hmacHex(secret,check,true));
  const fresh=new MemoryRepo(env),sess=await createSession(fresh,'42','mini_app','1h'),bad=sess.token.slice(0,-1)+(sess.token.endsWith('a')?'b':'a');
  await assert.rejects(()=>authenticateMiniApi(new Request('https://x/api/dashboard',{headers:{'x-telegram-init-data':p.toString(),cookie:`pf_session=${bad}`}}),fresh,env),/UNAUTHORIZED/);
});

test('refund reduces net expense without becoming income and transfer is not expense',async()=>{
  const repo=new MemoryRepo();await seed(repo);const f=new FinanceService(repo);
  const original=await f.createTransaction({type:'expense',amount:500000,fee_amount:10000,account_id:'acc-a',category_id:'cat-food',transaction_date:'2026-08-09',description:'خرید'});
  await f.createTransaction({type:'refund',amount:200000,fee_amount:1000,parent_transaction_id:original.transaction_id,account_id:'acc-a',transaction_date:'2026-08-09'});
  await f.createTransaction({type:'transfer',amount:100000,fee_amount:2000,account_id:'acc-a',destination_account_id:'acc-b',transaction_date:'2026-08-09'});
  const r=await report(repo,{from:'2026-08-09',to:'2026-08-09'});assert.equal(r.summary.expense,500000);assert.equal(r.summary.refunds,200000);assert.equal(r.summary.net_expense,300000);assert.equal(r.summary.income,0);assert.equal(r.summary.fees,13000);
});

test('debt partial settlement with fee recalculates after delete and restore',async()=>{
  const repo=new MemoryRepo();const x=await seed(repo),f=new FinanceService(repo);const d=await f.createDebt({person_id:x.person.person_id,amount:900000,account_id:'acc-a',description:'قرض',date:'2026-08-09'});
  const pay=await f.settleDebt(d.debt.debt_id,{amount:300000,account_id:'acc-a',fee_amount:7000,date:'2026-08-09'});let debt=await repo.getById('Debts',d.debt.debt_id);assert.equal(Number(debt.settled_amount),300000);assert.equal(debt.status,'partial');
  await f.softDeleteTransaction(pay.transaction.transaction_id);debt=await repo.getById('Debts',d.debt.debt_id);assert.equal(Number(debt.settled_amount),0);assert.equal(debt.status,'open');await f.restoreTransaction(pay.transaction.transaction_id);debt=await repo.getById('Debts',d.debt.debt_id);assert.equal(Number(debt.settled_amount),300000);
});

test('installment aggregate follows soft delete, restore and partial payments',async()=>{
  const repo=new MemoryRepo();await seed(repo);const f=new FinanceService(repo);await repo.insert('Installments',{installment_id:'inst-x',title:'قسط',total_amount:3000000,installment_count:3,default_installment_amount:1000000,start_date:'2026-08-01',due_day:10,account_id:'acc-a',status:'active'},{audit:false});
  const p=await f.payInstallment('inst-x',{amount:600000,fee_amount:12000,account_id:'acc-a',date:'2026-08-09'});assert.equal((await f.installmentSummary('inst-x')).paid,600000);await f.softDeleteTransaction(p.transaction.transaction_id);assert.equal((await f.installmentSummary('inst-x')).paid,0);await f.restoreTransaction(p.transaction.transaction_id);assert.equal((await f.installmentSummary('inst-x')).paid,600000);
});

test('CSV parser supports mapping and import/confirm are idempotent',async()=>{
  const repo=new MemoryRepo();await seed(repo);const f=new FinanceService(repo),csv='تاریخ,مبلغ,شرح,شماره پیگیری\n2026-08-09,120000,سوپرمارکت,T100\n';const rows=rowsFromCsv(csv);assert.equal(rows.length,1);assert.equal(rows[0].tracking_number,'T100');const a=await previewImport(repo,{file_name:'same.csv',account_id:'acc-a',rows}),b=await previewImport(repo,{file_name:'same.csv',account_id:'acc-a',rows});assert.equal(b.idempotent,true);assert.equal(a.import.import_id,b.import.import_id);const c1=await confirmImport(repo,f,a.import.import_id,{}),c2=await confirmImport(repo,f,a.import.import_id,{});assert.deepEqual(c2.created,c1.created);assert.equal((await repo.list('Transactions')).length,1);
});

test('deleted transactions and drafts never enter reports',async()=>{
  const repo=new MemoryRepo();await seed(repo);const f=new FinanceService(repo),tx=await f.createTransaction({type:'expense',amount:100000,account_id:'acc-a',transaction_date:'2026-08-09',description:'حذف‌شونده'});await repo.insert('Drafts',{draft_id:'d1',kind:'mini_tx',status:'active',state_json:JSON.stringify({amount:999999}),created_at:new Date().toISOString(),updated_at:new Date().toISOString()},{audit:false});await f.softDeleteTransaction(tx.transaction_id);const r=await report(repo,{from:'2026-08-09',to:'2026-08-09'});assert.equal(r.summary.expense,0);assert.equal(r.transactions.length,0);
});

test('recurrence handles Jalali monthly and custom intervals deterministically',()=>{assert.equal(nextOccurrence('2026-08-09','monthly'),'2026-09-09');assert.equal(nextOccurrence('2026-08-09','custom',{unit:'days',interval:3}),'2026-08-12')});

test('portable backup preview and restore preserve stable IDs',async()=>{
  const repo=new MemoryRepo();await seed(repo);const f=new FinanceService(repo);const tx=await f.createTransaction({type:'expense',amount:70000,account_id:'acc-a',transaction_date:'2026-08-09',description:'پشتیبان'}),backup=await createBackup(repo),fresh=new MemoryRepo();const p=await previewRestore(fresh,backup);assert.ok(p.summary.Transactions.incoming>=1);await applyRestore(fresh,backup,{overwrite:false});assert.equal((await fresh.getById('Transactions',tx.transaction_id)).description,'پشتیبان');
});

test('undo restores the last safe transaction edit',async()=>{const repo=new MemoryRepo();await seed(repo);const f=new FinanceService(repo),tx=await f.createTransaction({type:'expense',amount:55000,account_id:'acc-a',transaction_date:'2026-08-09',description:'قبل'});await f.editTransaction(tx.transaction_id,{description:'بعد'});await undoLast(repo,f);assert.equal((await repo.getById('Transactions',tx.transaction_id)).description,'قبل')});
