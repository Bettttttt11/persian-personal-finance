import { addDaysIso, nextJalaliMonthDate, nextJalaliYearDate } from './jalali.js';
import { safeJsonParse } from './utils.js';

export function nextOccurrence(iso,frequency='monthly',custom={}){
  const cfg=safeJsonParse(custom,{})||{},interval=Math.max(1,Math.min(365,Number(cfg.interval||1)));
  if(frequency==='daily')return addDaysIso(iso,1);
  if(frequency==='weekly')return addDaysIso(iso,7);
  if(frequency==='monthly')return nextJalaliMonthDate(iso,1);
  if(frequency==='yearly')return nextJalaliYearDate(iso,1);
  if(frequency==='custom'){
    const unit=cfg.unit||'days';if(unit==='days')return addDaysIso(iso,interval);if(unit==='weeks')return addDaysIso(iso,interval*7);if(unit==='months')return nextJalaliMonthDate(iso,interval);if(unit==='years')return nextJalaliYearDate(iso,interval);
  }
  throw new Error('VALIDATION');
}
export function advancePastDate(iso,frequency,custom,today){let next=iso;for(let i=0;i<500&&next<=today;i++)next=nextOccurrence(next,frequency,custom);return next;}
