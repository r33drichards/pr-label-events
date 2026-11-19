import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Service, DEFAULTS } from '../src/service.js';
import { httpServer } from '../src/http.js';
const secret='synthetic-test-secret-'.repeat(3);
const input={repo:'r33drichards/mcp-js',label:'hclmb',...DEFAULTS};
const fixture=(action='labeled',tick=0)=>({action,number:12,label:{name:'hclmb'},repository:{id:123,full_name:input.repo,private:false},pull_request:{id:456,number:12,head:{sha:'a'.repeat(40)},base:{repo:{id:123,full_name:input.repo}},updated_at:new Date(1700000000000+tick*1000).toISOString(),body:'PRIVATE BODY MUST NOT PERSIST'}});
function signed(p,delivery=randomUUID()){const raw=Buffer.from(JSON.stringify(p));return [raw,{'x-github-event':'pull_request','x-github-delivery':delivery,'x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(raw).digest('hex')}];}
async function setup(path){const pg=new PGlite(path);const db={query:(sql,params)=>!params&&sql.includes('CREATE TABLE')?pg.exec(sql):pg.query(sql,params),transaction:fn=>pg.transaction(fn)};const s=new Service(db,secret);await s.init();return {pg,s};}
test('signed transitions, immutable prompt versions, dedup and restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'label-events-'));let pg;
 try { let ctx=await setup(dir);pg=ctx.pg;let s=ctx.s;await s.subscribe(input);
 const first=signed(fixture());const a=await s.receive(...first);assert.equal(a.status,201);
 assert.equal((await s.receive(...first)).duplicate,true);
 const alteredHeaders={...first[1],'x-github-delivery':randomUUID()};assert.equal((await s.receive(first[0],alteredHeaders)).event_id,a.event_id);
 assert.equal((await s.receive(...signed(fixture('unlabeled',1),first[1]['x-github-delivery']))).status,409);
 await s.subscribe({...input,on_added:'New administrator prompt'},'update');
 const b=await s.receive(...signed(fixture('unlabeled',1)));const c=await s.receive(...signed(fixture('labeled',2)));assert.equal(b.status,201);assert.equal(c.status,201);
 const event=await s.get(a.event_id);assert.equal(event.prompt_version,1);assert.equal(event.handler.on_added,DEFAULTS.on_added);assert.equal((await s.get(c.event_id)).prompt_version,2);assert.ok(!JSON.stringify(event).includes('PRIVATE BODY'));
 await pg.close();ctx=await setup(dir);pg=ctx.pg;s=ctx.s;assert.equal((await s.receive(...first)).duplicate,true);assert.equal((await s.get(a.event_id)).head,'a'.repeat(40));
 let recovered=0;await s.drain(async()=>{recovered++;});assert.equal(recovered,3);
 await s.unsubscribe(input);assert.equal((await s.receive(...signed(fixture('labeled',3)))).ignored,true);
 await s.subscribe(input);assert.equal((await s.list())[0].version,3);
 }finally{if(pg)await pg.close();await rm(dir,{recursive:true,force:true});}
});
test('invalid signatures, malformed and ignored payloads, scope enforcement',async()=>{
 const {pg,s}=await setup();try{await s.subscribe(input);const x=signed(fixture());
 assert.equal((await s.receive(Buffer.from('{}'),x[1])).status,401);
 assert.equal((await s.receive(x[0],{...x[1],'x-hub-signature-256':'sha256=00'})).status,401);
 for(const p of [fixture('opened'),{...fixture(),repository:{id:123,private:false,full_name:'other/repo'}},{...fixture(),label:{name:'wreview'}}]) assert.equal((await s.receive(...signed(p))).ignored,true);
 assert.equal((await s.receive(...signed({...fixture(),number:'12'}))).status,400);
 assert.equal((await s.receive(...signed({...fixture(),pull_request:{...fixture().pull_request,head:{sha:'invalid'}}}))).status,400);
 assert.equal((await s.receive(x[0],{...x[1],'x-github-event':'issues'})).ignored,true);
 assert.equal((await s.receive(...signed({action:'labeled',repository:fixture().repository,label:fixture().label,number:12}))).status,400);
 await assert.rejects(()=>s.subscribe({...input,repo:'other/repo'}));
 assert.equal((await s.db.query('SELECT * FROM events')).rows.length,0);
 }finally{await pg.close();}
});
test('durable bounded retries and event-ID-only wake',async()=>{
 const {pg,s}=await setup();try{await s.subscribe(input);const a=await s.receive(...signed(fixture()));let calls=0;
 for(let i=0;i<6;i++)await s.drain(async id=>{assert.equal(id,a.event_id);calls++;throw Error('offline');},new Date(Date.now()+i*3600000));
 assert.equal(calls,5);assert.equal((await s.db.query('SELECT status FROM outbox')).rows[0].status,'failed');
 const b=await s.receive(...signed(fixture('unlabeled',1)));await s.drain(async id=>assert.equal(id,b.event_id));assert.equal((await s.db.query("SELECT count(*)::integer n FROM outbox WHERE status='sent'")).rows[0].n,1);
 }finally{await pg.close();}
});
test('Streamable HTTP authentication, read/admin separation, lookup and origin protection',async()=>{
 const {pg,s}=await setup();const readToken='read-test-'.repeat(5),adminToken='admin-test-'.repeat(5);
 const server=httpServer(s,{readToken,adminToken,origin:'http://127.0.0.1:18765'});await new Promise(resolve=>server.listen(18765,'127.0.0.1',resolve));
 const rpc=async(token,method,params={})=>fetch('http://127.0.0.1:18765/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 try{
 assert.equal((await rpc('bad','tools/list')).status,401);
 assert.deepEqual((await (await rpc(readToken,'tools/list')).json()).result.tools.map(x=>x.name),['get_label_event']);
 assert.equal((await (await rpc(adminToken,'tools/list')).json()).result.tools.length,5);
 const deny=await (await rpc(readToken,'tools/call',{name:'subscribe_label',arguments:input})).json();assert.ok(deny.error || deny.result?.isError);
 const sub=await (await rpc(adminToken,'tools/call',{name:'subscribe_label',arguments:input})).json();assert.ok(!sub.result.isError);
 const sig=signed(fixture());const r=await fetch('http://127.0.0.1:18765/github',{method:'POST',headers:sig[1],body:sig[0]});assert.equal(r.status,201);const event=await r.json();
 const found=await (await rpc(readToken,'tools/call',{name:'get_label_event',arguments:{event_id:event.event_id}})).json();assert.equal(JSON.parse(found.result.content[0].text).label,'hclmb');
 assert.equal((await fetch('http://127.0.0.1:18765/health')).status,200);
 assert.equal((await fetch('http://127.0.0.1:18765/health',{headers:{origin:'https://evil.example'}})).status,403);
 }finally{await new Promise(resolve=>server.close(resolve));await pg.close();}
});
