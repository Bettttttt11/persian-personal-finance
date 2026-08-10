export const SCHEMA_VERSION = 5;
export const DEFAULT_CURRENCY = 'TOMAN';
export const SESSION_TIMEOUTS = { '15m': 900, '30m': 1800, '1h': 3600, manual: null };

export function uuid() { return crypto.randomUUID(); }
export function nowIso() { return new Date().toISOString(); }
export function todayIso() { return new Date().toISOString().slice(0, 10); }
export function digitsEn(v='') {
  const fa='۰۱۲۳۴۵۶۷۸۹', ar='٠١٢٣٤٥٦٧٨٩';
  return String(v).replace(/[۰-۹]/g,d=>fa.indexOf(d)).replace(/[٠-٩]/g,d=>ar.indexOf(d));
}
export function normalizeSpace(v='') { return digitsEn(v).replace(/[\u200c\u200f\u202a-\u202e]/g,' ').replace(/\s+/g,' ').trim(); }
export function normalizeText(v='') { return normalizeSpace(v).toLowerCase().replace(/[ي]/g,'ی').replace(/[ك]/g,'ک'); }
export function parseMoney(v) {
  const s=digitsEn(v).replace(/[,_،\s]/g,'').replace(/تومان|تومن|ریال/g,'');
  if(!/^-?\d+$/.test(s)) throw new Error('INVALID_MONEY');
  const n=Number(s); if(!Number.isSafeInteger(n)) throw new Error('INVALID_MONEY'); return n;
}
export function moneyFa(n=0) { return Number(n||0).toLocaleString('fa-IR')+' تومان'; }
export function bool(v) { if(v===true || v===1)return true; const s=String(v??'').trim().toLowerCase(); return s==='true' || s==='1' || s==='yes' || s==='on'; }
export function safeJsonParse(v, fallback=null) { try { return typeof v==='string' ? JSON.parse(v) : v ?? fallback; } catch { return fallback; } }
export function json(v) { return JSON.stringify(v ?? null); }
export function htmlEscape(s='') { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
export function tgEscape(s='') { return htmlEscape(s); }
export function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
export function b64urlText(text) { return b64url(new TextEncoder().encode(text)); }
export function fromB64url(s) { s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; return Uint8Array.from(atob(s),c=>c.charCodeAt(0)); }
export async function sha256Hex(text) { const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export async function hmac(key,data,rawKey=false) {
  const k=await crypto.subtle.importKey('raw',rawKey?key:new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(data)));
}
export async function hmacHex(key,data,rawKey=false) { return [...await hmac(key,data,rawKey)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export function constantTimeEqual(a,b) { a=String(a); b=String(b); if(a.length!==b.length)return false; let r=0; for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i); return r===0; }
export function responseJson(data,status=200,extra={}) { return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...securityHeaders(),...extra}}); }
export function securityHeaders() { return {'x-content-type-options':'nosniff','x-frame-options':'SAMEORIGIN','referrer-policy':'no-referrer','permissions-policy':'camera=(self), microphone=(self)','cross-origin-opener-policy':'same-origin-allow-popups'}; }
export function bad(message='درخواست نامعتبر است.',status=400,code='BAD_REQUEST') { return responseJson({ok:false,error:{code,message}},status); }
export function ok(data={}) { return responseJson({ok:true,...data}); }
export function userError(err) {
  const map={INVALID_MONEY:'مبلغ معتبر نیست.',UNAUTHORIZED:'دسترسی مجاز نیست.',PIN_LOCKED:'ورود موقتاً قفل شده است.',PIN_WRONG:'رمز نادرست است.',NOT_FOUND:'مورد پیدا نشد.',VALIDATION:'اطلاعات واردشده معتبر نیست.',AI_DISABLED:'مدل هوش مصنوعی تنظیم نشده است.',AI_FAILED:'پاسخ هوش مصنوعی قابل استفاده نبود.',AI_INVALID_JSON:'پاسخ ساختاری هوش مصنوعی معتبر نبود.',AI_INVALID_ACTION:'عملیات پیشنهادی هوش مصنوعی معتبر نیست.',R2_DISABLED:'فضای فایل تنظیم نشده است.',CONFIG_SESSION_SECRET:'تنظیم امنیت Session کامل نیست.',IMPORT_REVIEW_REQUIRED:'این مورد باید قبل از ثبت بررسی شود.'};
  return map[err?.message] || 'خطایی رخ داد. دوباره تلاش کنید.';
}
export function redactError(err) { return {name:err?.name||'Error',message:String(err?.message||'error').slice(0,180)}; }
export function corsHeaders(request, baseUrl) {
  const o=request.headers.get('origin'); const allowed=new URL(baseUrl||request.url).origin;
  return o===allowed ? {'access-control-allow-origin':allowed,'access-control-allow-credentials':'true','access-control-allow-headers':'content-type,x-telegram-init-data,x-idempotency-key','access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS','vary':'origin'} : {};
}
export function getCookie(request,name) { const c=request.headers.get('cookie')||''; const m=c.match(new RegExp('(?:^|;\\s*)'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)')); return m?decodeURIComponent(m[1]):null; }
export function setCookie(name,value,maxAge) { return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned${maxAge==null?'':`; Max-Age=${maxAge}`}`; }
export function clearCookie(name) { return `${name}=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0`; }
export function clamp(n,min,max){ return Math.min(max,Math.max(min,n)); }
export function chunk(a,n){ const out=[]; for(let i=0;i<a.length;i+=n)out.push(a.slice(i,i+n)); return out; }
export function sortFavorites(a,b){ return Number(bool(b.favorite))-Number(bool(a.favorite)) || String(a.name||a.title||'').localeCompare(String(b.name||b.title||''),'fa'); }
export function toCsv(rows, headers){ const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"'; return '\ufeff'+[headers.map(esc).join(','),...rows.map(r=>headers.map(h=>esc(r[h])).join(','))].join('\r\n'); }
