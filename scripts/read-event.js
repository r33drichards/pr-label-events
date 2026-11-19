import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const endpoint=new URL(process.env.MCP_URL);
if(endpoint.protocol!=='https:') throw Error('HTTPS MCP endpoint required');
if(!process.env.READ_TOKEN || !process.argv[2]) throw Error('Set READ_TOKEN and provide event UUID');
const client=new Client({name:'pr-label-event-reader',version:'1.0.0'});
try {
 await client.connect(new StreamableHTTPClientTransport(endpoint,{requestInit:{headers:{Authorization:`Bearer ${process.env.READ_TOKEN}`}}}));
 const result=await client.callTool({name:'get_label_event',arguments:{event_id:process.argv[2]}});
 console.log(JSON.stringify(result));
} finally {await client.close();}
