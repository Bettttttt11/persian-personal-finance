import { digitsEn } from './utils.js';
function div(a,b){return Math.trunc(a/b);}function mod(a,b){return a-Math.trunc(a/b)*b;}
export function jalaliToGregorian(jy,jm,jd){
  jy=Number(jy);jm=Number(jm);jd=Number(jd);jy+=1595;let days=-355668+365*jy+div(jy,33)*8+div(mod(jy,33)+3,4)+jd+(jm<7?(jm-1)*31:(jm-7)*30+186);
  let gy=400*div(days,146097);days=mod(days,146097);if(days>36524){gy+=100*div(--days,36524);days=mod(days,36524);if(days>=365)days++;}
  gy+=4*div(days,1461);days=mod(days,1461);if(days>365){gy+=div(days-1,365);days=mod(days-1,365);}
  let gd=days+1;const months=[0,31,(gy%4===0&&gy%100!==0)||gy%400===0?29:28,31,30,31,30,31,31,30,31,30,31];let gm=1;for(;gm<=12&&gd>months[gm];gm++)gd-=months[gm];return{gy,gm,gd};
}
export function gregorianToJalali(gy,gm,gd){
  const gdm=[0,31,59,90,120,151,181,212,243,273,304,334];let gy2=gm>2?gy+1:gy,days=355666+365*gy+div(gy2+3,4)-div(gy2+99,100)+div(gy2+399,400)+gd+gdm[gm-1];
  let jy=-1595+33*div(days,12053);days=mod(days,12053);jy+=4*div(days,1461);days=mod(days,1461);if(days>365){jy+=div(days-1,365);days=mod(days-1,365);}const jm=days<186?1+div(days,31):7+div(days-186,30),jd=1+(days<186?mod(days,31):mod(days-186,30));return{jy,jm,jd};
}
export function tehranToday(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function addIsoDays(iso,days){const [y,m,d]=iso.split('-').map(Number),date=new Date(Date.UTC(y,m-1,d));date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);}
function validGregorian(y,m,d){if(y<1900||m<1||m>12||d<1||d>31)return false;const x=new Date(Date.UTC(y,m-1,d));return x.getUTCFullYear()===y&&x.getUTCMonth()+1===m&&x.getUTCDate()===d;}
function validJalali(y,m,d){if(y<1300||y>=1600||m<1||m>12||d<1||d>31)return false;const g=jalaliToGregorian(y,m,d),back=gregorianToJalali(g.gy,g.gm,g.gd);return back.jy===y&&back.jm===m&&back.jd===d;}
export function parseDateInput(input,now=new Date()){
  const value=digitsEn(String(input||'').trim());if(value==='امروز')return tehranToday(now);if(value==='دیروز')return addIsoDays(tehranToday(now),-1);
  const match=value.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);if(!match)throw new Error('VALIDATION');const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  if(year>=1300&&year<1600){if(!validJalali(year,month,day))throw new Error('VALIDATION');const g=jalaliToGregorian(year,month,day);return`${g.gy}-${String(g.gm).padStart(2,'0')}-${String(g.gd).padStart(2,'0')}`;}
  if(!validGregorian(year,month,day))throw new Error('VALIDATION');return`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
export function formatJalali(iso){const [y,m,d]=String(iso).slice(0,10).split('-').map(Number);if(!validGregorian(y,m,d))throw new Error('VALIDATION');const j=gregorianToJalali(y,m,d);return`${j.jy}/${String(j.jm).padStart(2,'0')}/${String(j.jd).padStart(2,'0')}`;}
export function jalaliMonthRange(now=new Date()){
  const today=tehranToday(now),[gy,gm,gd]=today.split('-').map(Number),j=gregorianToJalali(gy,gm,gd),first=jalaliToGregorian(j.jy,j.jm,1);let ny=j.jy,nm=j.jm+1;if(nm===13){nm=1;ny++;}const next=jalaliToGregorian(ny,nm,1),start=`${first.gy}-${String(first.gm).padStart(2,'0')}-${String(first.gd).padStart(2,'0')}`,end=addIsoDays(`${next.gy}-${String(next.gm).padStart(2,'0')}-${String(next.gd).padStart(2,'0')}`,-1);return{start,end,jy:j.jy,jm:j.jm};
}
export function nextJalaliMonthDate(iso,months=1){
  const [gy,gm,gd]=String(iso).slice(0,10).split('-').map(Number),j=gregorianToJalali(gy,gm,gd);let total=j.jy*12+(j.jm-1)+months,year=Math.floor(total/12),month=mod(total,12)+1,day=j.jd;while(day>28&&!validJalali(year,month,day))day--;const g=jalaliToGregorian(year,month,day);return`${g.gy}-${String(g.gm).padStart(2,'0')}-${String(g.gd).padStart(2,'0')}`;
}
export function nextJalaliYearDate(iso,years=1){const [gy,gm,gd]=String(iso).slice(0,10).split('-').map(Number),j=gregorianToJalali(gy,gm,gd);let day=j.jd;while(day>28&&!validJalali(j.jy+years,j.jm,day))day--;const g=jalaliToGregorian(j.jy+years,j.jm,day);return`${g.gy}-${String(g.gm).padStart(2,'0')}-${String(g.gd).padStart(2,'0')}`;}
export function addDaysIso(iso,days){return addIsoDays(iso,days);}
