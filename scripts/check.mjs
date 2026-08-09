import { readdir, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const root=new URL('../',import.meta.url),src=new URL('../src/',import.meta.url),files=(await readdir(src)).filter(x=>x.endsWith('.js'));
let failed=false;
for(const f of files){const p=new URL('../src/'+f,import.meta.url).pathname;const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status!==0){failed=true;console.error(r.stderr)}}
for(const rel of ['public/app.js','scripts/audit-ui.mjs']){const p=new URL('../'+rel,import.meta.url).pathname;const r=spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status!==0){failed=true;console.error(r.stderr)}}
const audit=spawnSync(process.execPath,[new URL('../scripts/audit-ui.mjs',import.meta.url).pathname],{encoding:'utf8'});if(audit.status!==0){failed=true;console.error(audit.stderr)}else process.stdout.write(audit.stdout);
const banned=['TO'+'DO','coming '+'soon','بعداً '+'اضافه می‌شود','place'+'holder','mo'+'ck'];
async function walk(url,rel=''){
  for(const name of await readdir(url)){if(name==='.git'||name==='node_modules'||name.endsWith('.zip'))continue;const child=new URL(name+(name.endsWith('/')?'':'') ,url);const st=await stat(child);const rp=rel+name;if(st.isDirectory()){await walk(new URL(name+'/',url),rp+'/');continue;}if(!/\.(js|mjs|html|css|md|jsonc|json|yml|yaml)$/.test(name))continue;const text=await readFile(child,'utf8');for(const marker of banned)if(text.toLowerCase().includes(marker.toLowerCase())){failed=true;console.error(`Marker ممنوع در ${rp}`);}}
}
await walk(root);
if(failed)process.exit(1);console.log(`Syntax OK: ${files.length+2} JavaScript files`);
