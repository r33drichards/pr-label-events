// Destructive fixtures are permitted only against this dedicated localhost smoke DB.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Service, DEFAULTS } from '../src/service.js';
import { httpServer } from '../src/http.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const url=new URL(process.env.SMOKE_DATABASE_URL);
assert.equal(url.hostname,'localhost');assert.equal(url.pathname,'/pr_label_smoke');
assert.equal(url.searchParams.get('sslmode'),'verify-full');
const pool=new pg.Pool({connectionString:url.href,max:2,connectionTimeoutMillis:10000});
const db={query:(...args)=>pool.query(...args),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const secret='synthetic-webhook-secret-'.repeat(3),readToken='synthetic-read-token-'.repeat(3),adminToken='synthetic-admin-token-'.repeat(3);
const service=new Service(db,secret);let server;const clients=[];
try {
 const untrusted=new URL(url);untrusted.searchParams.delete('sslrootcert');
 const rejectPool=new pg.Pool({connectionString:untrusted.href,connectionTimeoutMillis:10000});
 try {await assert.rejects(()=>rejectPool.query('SELECT 1'));} finally {await rejectPool.end();}
 const tls=await pool.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');assert.equal(tls.rows[0].ssl,true);
 await service.init();await db.query('TRUNCATE outbox,deliveries,events,subscriptions');
 server=httpServer(service,{readToken,adminToken,origin:'http://localhost:18766'});await new Promise(resolve=>server.listen(18766,'127.0.0.1',resolve));
 assert.equal((await fetch('http://localhost:18766/health')).status,200);
 const connect=async token=>{const client=new Client({name:'runtime-smoke',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:18766/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));clients.push(client);return client;};
 const admin=await connect(adminToken);const read=await connect(readToken);
 const sub=await admin.callTool({name:'subscribe_label',arguments:{repo:'r33drichards/mcp-js',label:'hclmb',...DEFAULTS}});assert.ok(!sub.isError);
 assert.deepEqual((await read.listTools()).tools.map(t=>t.name),['get_label_event']);
 const body=JSON.stringify({action:'labeled',number:1,label:{name:'hclmb'},repository:{id:123,full_name:'r33drichards/mcp-js',private:false},pull_request:{id:456,number:1,head:{sha:'a'.repeat(40)},base:{repo:{id:123,full_name:'r33drichards/mcp-js'}},updated_at:'2026-11-19T00:00:00Z'}});
 const headers={'x-github-delivery':randomUUID(),'x-github-event':'pull_request','x-hub-signature-256':'sha256='+createHmac('sha256',secret).update(body).digest('hex')};
 const post=(data,head=headers)=>fetch('http://localhost:18766/github',{method:'POST',headers:head,body:data});
 assert.equal((await post(body+' ')).status,401);const valid=await post(body);assert.equal(valid.status,201);const event=await valid.json();
 assert.equal((await post(body,{...headers,'x-github-delivery':randomUUID()})).status,200);
 const found=await read.callTool({name:'get_label_event',arguments:{event_id:event.event_id}});assert.equal(JSON.parse(found.content[0].text).head,'a'.repeat(40));
 console.log(JSON.stringify({runtime:process.version,versions:process.versions,health:true,hmac:true,dedup:true,mcpClient:true,postgresTLS:true,untrustedCertificateRejected:true}));
} finally {for(const c of clients)await c.close();if(server)await new Promise(resolve=>server.close(resolve));await pool.end();}
