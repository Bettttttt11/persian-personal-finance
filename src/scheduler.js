import { nowIso, uuid, SCHEMA_VERSION, moneyFa } from './utils.js';
import { telegramCall, webAppUrl } from './telegram-api.js';
import { budgetProgress, queryTransactions } from './reports.js';
import { jalaliMonthRange, jalaliToGregorian, tehranToday } from './jalali.js';

async function once(repo,type,entityId,periodKey,fn){
  const key=`${type}:${entityId}:${periodKey}`,old=await repo.findOne('Inbox',x=>x.type==='reminder_sent'&&x.entity_id===key);if(old)return false;
  await fn();await repo.insert('Inbox',{inbox_id:uuid(),type:'reminder_sent',entity_type:type,entity_id:key,title:'یادآوری ارسال شد',payload_json:'{}',status:'done',created_at:nowIso(),updated_at:nowIso(),schema_version:SCHEMA_VERSION},{audit:false});return true;
}
function dueDateForJalaliMonth(range,dueDay){
  let day=Math.max(1,Math.min(31,Number(dueDay||1))),g;while(day>28){try{g=jalaliToGregorian(range.jy,range.jm,day);const iso=`${g.gy}-${String(g.gm).padStart(2,'0')}-${String(g.gd).padStart(2,'0')}`;if(iso>=range.start&&iso<=range.end)return iso;}catch{}day--;}
  g=jalaliToGregorian(range.jy,range.jm,day);return`${g.gy}-${String(g.gm).padStart(2,'0')}-${String(g.gd).padStart(2,'0')}`;
}
function dashboardRow(env,requestUrl,text){const raw=env.PUBLIC_BASE_URL||(!String(requestUrl||'').includes('worker.invalid')?requestUrl:'');if(!raw)return null;return[{text,web_app:{url:webAppUrl(env,raw)}}];}
export async function runDaily(repo,env,requestUrl='https://worker.invalid'){
  const today=tehranToday(),owner=env.OWNER_TELEGRAM_ID,period=jalaliMonthRange(),periodKey=`${period.jy}-${String(period.jm).padStart(2,'0')}`,prefs=await repo.setting('reminder_preferences',{recurring:true,installments:true,debts:true,budgets:true}),sent=[];
  if(prefs?.recurring!==false){
    const recurring=await repo.list('Recurring',{limit:1000,filter:x=>String(x.enabled)!=='false'&&x.next_due_date&&x.next_due_date<=today});
    for(const item of recurring)if(await once(repo,'recurring',item.recurring_id,item.next_due_date,()=>telegramCall(env,'sendMessage',{chat_id:owner,text:`🔁 ${item.title}\n${moneyFa(item.amount)}\nموعد: ${item.next_due_date}`,reply_markup:{inline_keyboard:[[{text:'✅ ثبت',callback_data:`rec:post:${item.recurring_id}`},{text:'رد',callback_data:`rec:skip:${item.recurring_id}`}],...(dashboardRow(env,requestUrl,'✏️ ویرایش')?[dashboardRow(env,requestUrl,'✏️ ویرایش')]:[])]}})))sent.push(`recurring:${item.recurring_id}`);
  }
  if(prefs?.installments!==false){
    const [plans,payments]=await Promise.all([repo.list('Installments',{limit:1000,filter:x=>x.status!=='completed'&&String(x.archived)!=='true'}),repo.list('InstallmentPayments',{limit:10000})]);
    for(const plan of plans){const due=dueDateForJalaliMonth(period,plan.due_day),alreadyPaid=payments.some(p=>p.installment_id===plan.installment_id&&p.payment_date>=period.start&&p.payment_date<=period.end);if(!alreadyPaid&&today>due&&plan.status!=='overdue')await repo.updateById('Installments',plan.installment_id,{status:'overdue'},{audit:false});if(!alreadyPaid&&today>=due&&await once(repo,'installment',plan.installment_id,periodKey,()=>telegramCall(env,'sendMessage',{chat_id:owner,text:`💳 یادآوری قسط\n${plan.title}\nمبلغ پیش‌فرض: ${moneyFa(plan.default_installment_amount)}\nسررسید: ${due}`,reply_markup:{inline_keyboard:[[{text:'ثبت پرداخت',callback_data:`inst:pay:${plan.installment_id}`},{text:'جزئیات',callback_data:`inst:view:${plan.installment_id}`}]]}})))sent.push(`installment:${plan.installment_id}`);}
  }
  if(prefs?.debts!==false){
    const debts=await repo.list('Debts',{limit:2000,filter:x=>x.status!=='settled'&&x.due_date&&x.due_date<=today});for(const debt of debts)if(await once(repo,'debt',debt.debt_id,debt.due_date,()=>telegramCall(env,'sendMessage',{chat_id:owner,text:`👥 یادآوری ${debt.kind==='receivable'?'طلب':'بدهی'}\nمانده: ${moneyFa(Number(debt.principal_amount)-Number(debt.settled_amount||0))}`,reply_markup:{inline_keyboard:[[{text:'مشاهده',callback_data:`debt:view:${debt.debt_id}`}]]}})))sent.push(`debt:${debt.debt_id}`);
  }
  if(prefs?.budgets!==false){
    const txs=await queryTransactions(repo,{from:period.start,to:today}),budgets=await budgetProgress(repo,period,txs);
    for(const budget of budgets){const thresholds=[...(budget.thresholds||[80,90,100])].map(Number).sort((a,b)=>b-a),hit=thresholds.find(x=>budget.percent>=x);if(hit&&await once(repo,`budget${hit}`,budget.budget_id,periodKey,()=>telegramCall(env,'sendMessage',{chat_id:owner,text:`⚠️ بودجه به ${Number(budget.percent).toLocaleString('fa-IR')}٪ رسیده است.\nمصرف: ${moneyFa(budget.used)} از ${moneyFa(budget.amount)}`,reply_markup:{inline_keyboard:dashboardRow(env,requestUrl,'گزارش بودجه')?[dashboardRow(env,requestUrl,'گزارش بودجه')]:[]}})))sent.push(`budget:${budget.budget_id}`);}
  }
  const expiredDrafts=await repo.list('Drafts',{limit:5000,filter:x=>x.status==='active'&&x.expires_at&&x.expires_at<nowIso()});for(const draft of expiredDrafts)await repo.updateById('Drafts',draft.draft_id,{status:'expired'},{audit:false});
  return{date:today,sent};
}
