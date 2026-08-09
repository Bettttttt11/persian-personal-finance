import { handleTelegram } from './telegram.js';
import { handleApi } from './api.js';
import { Repository } from './repository.js';
import { runDaily } from './scheduler.js';
import { securityHeaders } from './utils.js';

function telegramSecretOk(request,env){if(!env.TELEGRAM_WEBHOOK_SECRET)return true;return request.headers.get('x-telegram-bot-api-secret-token')===env.TELEGRAM_WEBHOOK_SECRET;}
function needsWriteGate(request,url){if(url.pathname==='/api/backup')return true;if((url.pathname==='/telegram'||url.pathname==='/')&&request.method==='POST')return true;if(url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(request.method))return true;return false;}

async function dispatch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/__scheduled'){
    const repo=new Repository(env,'recurring');
    const result=await runDaily(repo,env,env.PUBLIC_BASE_URL||'https://worker.invalid');
    return Response.json(result);
  }
  if((url.pathname==='/telegram'||url.pathname==='/')&&request.method==='POST'){
    if(!telegramSecretOk(request,env))return new Response('forbidden',{status:403,headers:securityHeaders()});
    return handleTelegram(request,env);
  }
  if(url.pathname.startsWith('/api/'))return handleApi(request,env);
  if(url.pathname==='/app'||url.pathname==='/app/'){
    if(env.ASSETS){const u=new URL(request.url);u.pathname='/app.html';return env.ASSETS.fetch(new Request(u,request));}
    return new Response('Mini App assets binding is not configured.',{status:503,headers:{'content-type':'text/plain; charset=utf-8',...securityHeaders()}});
  }
  if(url.pathname==='/'&&request.method==='GET')return Response.redirect(new URL('/app',request.url),302);
  if(env.ASSETS)return env.ASSETS.fetch(request);
  return new Response('Not Found',{status:404,headers:securityHeaders()});
}

export class WriteGate{
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.queue=Promise.resolve();}
  fetch(request){const run=this.queue.then(()=>dispatch(request,this.env));this.queue=run.catch(()=>{});return run;}
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    try{
      if(env.WRITE_GATE&&needsWriteGate(request,url))return env.WRITE_GATE.getByName('owner').fetch(request);
      return await dispatch(request,env);
    }catch{return new Response('Service unavailable',{status:500,headers:{'content-type':'text/plain; charset=utf-8',...securityHeaders()}});}
  },
  async scheduled(controller,env,ctx){
    if(env.WRITE_GATE){ctx.waitUntil(env.WRITE_GATE.getByName('owner').fetch('https://internal.invalid/__scheduled').then(()=>{}).catch(()=>{}));return;}
    const repo=new Repository(env,'recurring');ctx.waitUntil(runDaily(repo,env,env.PUBLIC_BASE_URL||'https://worker.invalid').catch(()=>{}));
  }
};
