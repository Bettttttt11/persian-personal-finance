import { readFile } from 'node:fs/promises';

const telegram=await readFile(new URL('../src/telegram.js',import.meta.url),'utf8');
const start=telegram.indexOf('async function handleCallback');
const end=telegram.indexOf('\nasync function startInstallmentPayment',start);
if(start<0||end<0)throw new Error('Telegram callback handler پیدا نشد');
const handler=telegram.slice(start,end);

const exactCallbacks=[
  'm:home','m:add','m:tx','m:report','m:projects','m:people','m:installments','m:ai','m:settings','m:health','m:lock','ai:exit',
  'draft:resume','draft:discard','draft:new','cat:list','cat:new:menu','cat:new:wizard','w:amount:default','w:date:today','w:date:yesterday','w:date:manual',
  'w:desc:skip','w:preview','w:more','w:more:person','w:more:project','w:more:merchant','w:more:tags','w:personreturn:yes','w:personreturn:no',
  'w:new:project','w:new:merchant','w:more:fee','w:more:note','w:more:tracking','w:more:reference','w:more:receipt','w:receipt:done',
  'w:edit','w:edit:amount','w:edit:description','w:edit:account','w:edit:category','w:edit:date','w:cancel','w:confirm'
];
const callbackPrefixes=[
  'proj:','person:','inst:view:','inst:pay:','debt:view:','debt:full:','debt:part:','aiok:','aicancel:','airead:p:','airead:m:','aichoice:',
  'cat:view:','cat:rename:','cat:fav:','cat:archive:','tpl:','w:type:','w:inst:','w:refund:','w:acct:','w:dest:','w:cat:','w:person:',
  'w:newperson:','w:project:','w:merchant:','w:tag:','rec:post:','rec:skip:','receiptai:create:','receiptai:discard:','impacct:'
];
for(const value of [...exactCallbacks,...callbackPrefixes])if(!handler.includes(value))throw new Error(`Callback بدون handler: ${value}`);

const api=await readFile(new URL('../src/api.js',import.meta.url),'utf8'),apiNormalized=api.replaceAll('\\/','/');
const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const apiFamilies=[
  '/api/auth/','/api/admin/','/api/health','/api/dashboard','/api/transactions','/api/search','/api/reports','/api/accounts/',
  '/api/people/','/api/projects/','/api/installments/','/api/debts/','/api/undo','/api/changelog','/api/links','/api/inbox','/api/drafts',
  '/api/settings','/api/storage','/api/backup','/api/restore/','/api/export/csv','/api/receipts','/api/imports','/api/ai/','/api/splits','/api/trash','/api/merge/','/api/entities/'
];
for(const family of apiFamilies){if(app.includes(family)&&!apiNormalized.includes(family))throw new Error(`API family بدون route: ${family}`);}

for(const required of ['w:project:clear','w:merchant:clear'])if(!telegram.includes(required))throw new Error(`دکمه پاک‌کردن مفقود است: ${required}`);
if(!handler.includes("id==='clear'"))throw new Error('پاک‌کردن پروژه/فروشنده در handler پوشش داده نشده است');
console.log(`UI audit OK: ${exactCallbacks.length+callbackPrefixes.length} Telegram callback families + API families`);
