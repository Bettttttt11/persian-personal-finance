import { SESSION_TIMEOUTS, b64url, constantTimeEqual, getCookie, hmac, hmacHex, nowIso, setCookie, sha256Hex, uuid } from './utils.js';

const MAX_INITDATA_AGE=86400;
const SESSION_COOKIE='pf_session';
const SESSION_PREFIX='v1';
const MINI_SESSION_CACHE=new Map();
const MINI_SESSION_CACHE_MS=60_000;
function cacheSession(session,hash){if(MINI_SESSION_CACHE.size>256){const first=MINI_SESSION_CACHE.keys().next().value;if(first)MINI_SESSION_CACHE.delete(first);}MINI_SESSION_CACHE.set(session.session_id,{session,hash,until:Date.now()+MINI_SESSION_CACHE_MS});}
function dropSessionCache(sessionId){MINI_SESSION_CACHE.delete(String(sessionId));}

export async function validateTelegramInitData(initData,botToken,ownerId){
  if(!initData||!botToken)throw new Error('UNAUTHORIZED');
  const p=new URLSearchParams(initData),received=p.get('hash');if(!received)throw new Error('UNAUTHORIZED');
  p.delete('hash');
  const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=await hmac('WebAppData',botToken),expected=await hmacHex(secret,check,true);
  if(!constantTimeEqual(received.toLowerCase(),expected.toLowerCase()))throw new Error('UNAUTHORIZED');
  const authDate=Number(p.get('auth_date')||0),now=Math.floor(Date.now()/1000);if(!authDate||Math.abs(now-authDate)>MAX_INITDATA_AGE)throw new Error('UNAUTHORIZED');
  let user;try{user=JSON.parse(p.get('user')||'{}')}catch{throw new Error('UNAUTHORIZED')}
  if(String(user.id)!==String(ownerId))throw new Error('UNAUTHORIZED');return user;
}

async function lockState(repo,telegramId){return repo.findOne('AuthState',r=>String(r.telegram_id)===String(telegramId));}
async function pinHash(env,pin){if(!env.SESSION_SECRET||String(env.SESSION_SECRET).length<24)throw new Error('CONFIG_SESSION_SECRET');return hmacHex(env.SESSION_SECRET,`pin:v1:${String(pin||'')}`);}
export async function pinRequired(repo,env){
  const configured=await repo.setting('pin_enabled',null);if(configured!==null&&configured!==undefined)return configured===true||String(configured).toLowerCase()==='true';
  const stored=String(await repo.setting('pin_hash','')||'');return !!stored||!!env.BOT_PIN;
}
export async function pinStatus(repo,env){return{enabled:await pinRequired(repo,env),custom:!!String(await repo.setting('pin_hash','')||''),legacy_env:!!env.BOT_PIN};}
export async function setPin(repo,env,pin){const value=String(pin||'').trim();if(value.length<4||value.length>32)throw new Error('VALIDATION');await repo.setSetting('pin_hash',await pinHash(env,value));await repo.setSetting('pin_enabled',true);return pinStatus(repo,env);}
export async function disablePin(repo,env){await repo.setSetting('pin_enabled',false);return pinStatus(repo,env);}
export async function verifyPin(repo,env,telegramId,pin){
  if(!await pinRequired(repo,env))return true;
  const st=await lockState(repo,telegramId);if(st?.lock_until&&new Date(st.lock_until)>new Date())throw new Error('PIN_LOCKED');
  const stored=String(await repo.setting('pin_hash','')||''),candidate=String(pin||''),ok=stored?constantTimeEqual(await pinHash(env,candidate),stored):!!env.BOT_PIN&&constantTimeEqual(candidate,String(env.BOT_PIN));
  if(!ok){const fails=Number(st?.pin_fail_count||0)+1,lock=fails>=5?new Date(Date.now()+15*60*1000).toISOString():'';if(st)await repo.updateById('AuthState',st.auth_state_id,{pin_fail_count:fails,lock_until:lock},{audit:false});else await repo.insert('AuthState',{auth_state_id:uuid(),telegram_id:String(telegramId),pin_fail_count:fails,lock_until:lock,updated_at:nowIso()},{audit:false});throw new Error(lock?'PIN_LOCKED':'PIN_WRONG');}
  if(st)await repo.updateById('AuthState',st.auth_state_id,{pin_fail_count:0,lock_until:''},{audit:false});return true;
}
export async function miniAuthConfig(request,repo,env){const body=await request.json(),user=await validateTelegramInitData(body.initData,env.TELEGRAM_BOT_TOKEN,env.OWNER_TELEGRAM_ID);return{user:{id:user.id,first_name:user.first_name||''},pin_required:await pinRequired(repo,env)};}

async function signedCookieValue(env,sessionId,nonce){
  if(!env.SESSION_SECRET||String(env.SESSION_SECRET).length<24)throw new Error('CONFIG_SESSION_SECRET');
  const base=`${SESSION_PREFIX}.${sessionId}.${nonce}`,sig=await hmacHex(env.SESSION_SECRET,base);return `${base}.${sig}`;
}
async function verifySignedCookie(env,value){
  if(!env.SESSION_SECRET||!value)return null;const parts=String(value).split('.');if(parts.length!==4||parts[0]!==SESSION_PREFIX)return null;
  const [prefix,sessionId,nonce,sig]=parts,base=`${prefix}.${sessionId}.${nonce}`,expected=await hmacHex(env.SESSION_SECRET,base);if(!constantTimeEqual(sig,expected))return null;return{sessionId,nonce};
}

export async function createSession(repo,telegramId,channel,timeoutKey='1h'){
  const seconds=SESSION_TIMEOUTS[timeoutKey]===undefined?3600:SESSION_TIMEOUTS[timeoutKey],nonce=b64url(crypto.getRandomValues(new Uint8Array(32))),hash=await sha256Hex(nonce),expires=seconds==null?'':new Date(Date.now()+seconds*1000).toISOString();
  const session=await repo.insert('Sessions',{session_id:uuid(),channel,telegram_id:String(telegramId),token_hash:channel==='mini_app'?hash:'',created_at:nowIso(),last_seen_at:nowIso(),expires_at:expires,revoked_at:''},{audit:false});
  const token=channel==='mini_app'?await signedCookieValue(repo.env||{},session.session_id,nonce):'';return{session,token,maxAge:seconds==null?31536000:seconds};
}
export async function activeBotSession(repo,telegramId){const rows=await repo.list('Sessions',{limit:500});return rows.filter(r=>r.channel==='telegram'&&String(r.telegram_id)===String(telegramId)&&!r.revoked_at&&(!r.expires_at||r.expires_at>nowIso())).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0]||null;}
export async function authenticateMiniApi(request,repo,env){
  const init=request.headers.get('x-telegram-init-data')||'',user=await validateTelegramInitData(init,env.TELEGRAM_BOT_TOKEN,env.OWNER_TELEGRAM_ID),cookie=getCookie(request,SESSION_COOKIE),signed=await verifySignedCookie(env,cookie);if(!signed)throw new Error('UNAUTHORIZED');
  const hash=await sha256Hex(signed.nonce),cached=MINI_SESSION_CACHE.get(String(signed.sessionId));let s=null;
  if(cached&&cached.until>Date.now()&&cached.hash===hash&&String(cached.session.telegram_id)===String(user.id)&&!cached.session.revoked_at&&(!cached.session.expires_at||cached.session.expires_at>nowIso()))s=cached.session;
  if(!s){s=await repo.findOne('Sessions',r=>r.session_id===signed.sessionId&&r.channel==='mini_app'&&String(r.telegram_id)===String(user.id)&&r.token_hash===hash&&!r.revoked_at&&(!r.expires_at||r.expires_at>nowIso()));if(!s)throw new Error('UNAUTHORIZED');cacheSession(s,hash);}
  const lastSeen=Date.parse(s.last_seen_at||0);if(!lastSeen||Date.now()-lastSeen>5*60*1000){const updated={...s,last_seen_at:nowIso()};cacheSession(updated,hash);await repo.updateById('Sessions',s.session_id,{last_seen_at:updated.last_seen_at},{audit:false});s=updated;}return{user,session:s};
}
export async function revokeSession(repo,sessionId){dropSessionCache(sessionId);return repo.updateById('Sessions',sessionId,{revoked_at:nowIso()},{audit:false});}
export async function loginMiniApp(request,repo,env){const body=await request.json(),user=await validateTelegramInitData(body.initData,env.TELEGRAM_BOT_TOKEN,env.OWNER_TELEGRAM_ID);await verifyPin(repo,env,user.id,body.pin);const timeout=body.timeout||await repo.setting('session_timeout','1h'),s=await createSession(repo,user.id,'mini_app',timeout);return{user,session:s.session,cookie:setCookie(SESSION_COOKIE,s.token,s.maxAge)};}
export async function createBotAuth(repo,env,telegramId,pin){await verifyPin(repo,env,telegramId,pin);const timeout=await repo.setting('session_timeout','1h');return createSession(repo,telegramId,'telegram',timeout);}
export async function revokeBotSessions(repo,telegramId){const rows=await repo.list('Sessions',{limit:500});for(const s of rows.filter(x=>x.channel==='telegram'&&String(x.telegram_id)===String(telegramId)&&!x.revoked_at))await repo.updateById('Sessions',s.session_id,{revoked_at:nowIso()},{audit:false});}
