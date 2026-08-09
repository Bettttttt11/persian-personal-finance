import { b64url, b64urlText } from './utils.js';

function pemToBytes(pem){ const b64=pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,''); return Uint8Array.from(atob(b64),c=>c.charCodeAt(0)); }
export class GoogleSheetsClient {
  constructor(env){ this.env=env; this.sa=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); this.token=null; this.tokenExp=0; }
  async accessToken(){
    const now=Math.floor(Date.now()/1000); if(this.token && now < this.tokenExp-60) return this.token;
    const header=b64urlText(JSON.stringify({alg:'RS256',typ:'JWT',kid:this.sa.private_key_id}));
    const claims=b64urlText(JSON.stringify({iss:this.sa.client_email,scope:'https://www.googleapis.com/auth/spreadsheets',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
    const input=`${header}.${claims}`;
    const key=await crypto.subtle.importKey('pkcs8',pemToBytes(this.sa.private_key),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
    const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(input));
    const assertion=`${input}.${b64url(sig)}`;
    const body=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion});
    const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
    const j=await r.json(); if(!r.ok||!j.access_token) throw new Error('GOOGLE_AUTH_FAILED'); this.token=j.access_token;this.tokenExp=now+(j.expires_in||3600); return this.token;
  }
  async call(path, init={}){
    const token=await this.accessToken(); const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.env.SPREADSHEET_ID)}${path}`,{...init,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(init.headers||{})}});
    const text=await r.text(); let data={}; try{data=text?JSON.parse(text):{};}catch{data={raw:text.slice(0,200)}}
    if(!r.ok) { const e=new Error('GOOGLE_API_FAILED'); e.status=r.status; e.detail=data?.error?.message; throw e; } return data;
  }
  metadata(){ return this.call('?fields=sheets.properties'); }
  batchUpdate(requests){ return this.call(':batchUpdate',{method:'POST',body:JSON.stringify({requests})}); }
  createSheet(title){ return this.batchUpdate([{addSheet:{properties:{title}}}]); }
  valuesGet(range){ return this.call(`/values/${encodeURIComponent(range)}?majorDimension=ROWS`); }
  valuesBatchGet(ranges){ const qs=ranges.map(r=>`ranges=${encodeURIComponent(r)}`).join('&'); return this.call(`/values:batchGet?majorDimension=ROWS&${qs}`); }
  valuesUpdate(range,values){ return this.call(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`,{method:'PUT',body:JSON.stringify({range,majorDimension:'ROWS',values})}); }
  valuesAppend(range,values){ return this.call(`/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',body:JSON.stringify({range,majorDimension:'ROWS',values})}); }
  valuesBatchUpdate(data){ return this.call('/values:batchUpdate',{method:'POST',body:JSON.stringify({valueInputOption:'RAW',data})}); }
}
