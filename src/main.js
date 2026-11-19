import pg from 'pg';
import { Service, slackAdapter } from './service.js';
import { httpServer } from './http.js';
const env=process.env;
for(const key of ['DATABASE_URL','WEBHOOK_SECRET','READ_TOKEN','ADMIN_TOKEN','PUBLIC_ORIGIN']) if(!env[key]) throw Error(`Missing ${key}`);
if(new Set([env.WEBHOOK_SECRET,env.READ_TOKEN,env.ADMIN_TOKEN]).size!==3) throw Error('All credentials must be independent');
if(env.WEBHOOK_SECRET.length<32) throw Error('Strong webhook secret required');
if(env.NODE_ENV==='production' && !env.PUBLIC_ORIGIN.startsWith('https://')) throw Error('Production requires HTTPS');
const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:5});
const db={query:(...args)=>pool.query(...args),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
const service=new Service(db,env.WEBHOOK_SECRET);
await service.init();
// No subscriptions seeded silently. Use authenticated MCP subscribe_label after label verification.
const server=httpServer(service,{readToken:env.READ_TOKEN,adminToken:env.ADMIN_TOKEN,origin:env.PUBLIC_ORIGIN});
server.requestTimeout=15000;server.headersTimeout=10000;
let timer;
if(env.WAKE_MODE==='slack') {
  if(env.SLACK_DESTINATION_VERIFIED!=='true') throw Error('Slack destination requires operator verification');
  const adapter=slackAdapter({token:env.SLACK_BOT_TOKEN,channel:env.SLACK_CHANNEL_ID});
  let busy=false;timer=setInterval(async()=>{if(busy)return;busy=true;try{await service.drain(adapter);}catch{console.error('Outbox processing failed');}finally{busy=false;}},5000);
} else if(env.WAKE_MODE && env.WAKE_MODE!=='noop') throw Error('Unknown wake mode');
server.listen(Number(env.PORT || 8080),'0.0.0.0');
// noop retains pending events; it never sends or marks notifications delivered.
process.on('SIGTERM',()=>{clearInterval(timer);server.close(()=>{void pool.end();});});
