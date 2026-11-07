import { expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.OPENSELECT_DB_PATH=join(mkdtempSync(join(tmpdir(),'openselect-iteration-two-')),'db.sqlite');
const {getDb}=await import('../../src/db');
const {Runtime}=await import('../../src/state');
const {loadCatalog}=await import('../../src/catalog');
const {buildRoutingPlan}=await import('../../src/route_plan');
const {requestRequirements}=await import('../../src/route_capabilities');
const {clientModelProfile}=await import('../../src/client_profile');
const {handleProxyRequest}=await import('../../src/proxy');
const {readTraces,withRequestTrace,tracedFetch}=await import('../../src/request_trace');
const {ensureBackupKeychain}=await import('../../src/backup_keychain');
const catalog=await loadCatalog();
const cfg:any={version:1,upstream:{base:''},proxy:{host:'127.0.0.1',port:0},dashboard:{host:'127.0.0.1',port:0},policy:{switchAt:.99,maxAttempts:4,cooldownFallbackSec:1,sessionTtlSec:3600,codingAutoOrder:['zai','minimax','opencode']},monitor:{pollSec:300},opencode:{autoActivate:false},accounts:[]};
const mode=process.argv[2];
if(mode==='trace'){
 const captured:string[]=[];
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const key=req.headers.get('authorization')||'';
  captured.push(key);
  if(!key.endsWith('open-test')){await Bun.sleep(20);return Response.json({error:{message:'unavailable'}},{status:503});}
  return new Response(new ReadableStream({async start(c){
   const send=(value:any)=>c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n'));
   send({choices:[{delta:{content:'O'}}]});await Bun.sleep(20);
   send({choices:[{delta:{content:'K'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}});
   c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));c.close();
  }}),{headers:{'content-type':'text/event-stream'}});
 }});
 const base='http://127.0.0.1:'+upstream.port;
 cfg.upstream.base=base;cfg.accounts=[
  {id:'trace-zai',label:'z',integration:'zai',key:'zai-test',baseUrl:base,enabled:true,addedAt:0},
  {id:'trace-mm',label:'m',integration:'minimax',key:'mm-test',baseUrl:base,enabled:true,addedAt:0},
  {id:'trace-open',label:'o',integration:'opencode-go',key:'open-test',enabled:true,addedAt:0}];
 try{
  const rt=new Runtime(cfg,catalog);
  const response=await handleProxyRequest(rt,new Request('http://local/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'coding-auto',stream:true,max_tokens:16,messages:[{role:'user',content:'say OK'}]})}));
  expect(response.status).toBe(200);expect(await response.text()).toContain('text_delta');
  const id=response.headers.get('x-openselect-request-id')!;
  const data:any=readTraces(id),trace=data.traces[0];
  expect(data.attempts.map((a:any)=>a.provider)).toEqual(['zai','minimax','opencode-go']);
  expect(trace).toMatchObject({state:'complete',attempts:3,final_provider:'opencode-go'});
  expect(trace.retry_ms).toBeGreaterThanOrEqual(35);expect(trace.duration_ms).toBeGreaterThanOrEqual(trace.retry_ms+15);
  const rows=getDb().query('SELECT trace_id FROM requests WHERE trace_id=?').all(id);
  expect(rows.length).toBeGreaterThan(0);
  const final:any=getDb().query('SELECT attempts,duration_ms,retry_ms FROM requests WHERE trace_id=? AND status=200 ORDER BY id DESC LIMIT 1').get(id);
  expect(final.attempts).toBe(3);expect(final.retry_ms).toBeGreaterThanOrEqual(35);
  // Concurrent independent lifecycles must not inherit one another's IDs.
  const concurrent=await Promise.all([1,2].map(async()=>{
   const r=await withRequestTrace(new Request('http://local/v1/messages',{method:'POST'}),()=>tracedFetch(base,{headers:{authorization:'Bearer open-test'}},{provider:'opencode-go',model:'test',accountId:'x'}));
   await r.text();return r.headers.get('x-openselect-request-id');
  }));
  expect(concurrent[0]).not.toBe(concurrent[1]);
  const failed=await withRequestTrace(new Request('http://local/v1/messages',{method:'POST'}),async()=>{throw new Error('private error detail');});
  expect(failed.status).toBe(500);expect(await failed.text()).not.toContain('private error detail');
  expect((readTraces(failed.headers.get('x-openselect-request-id')!).traces[0] as any).state).toBe('failed');
  const cancelled=await withRequestTrace(new Request('http://local/v1/messages',{method:'POST'}),async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});}})));
  await cancelled.body!.cancel();
  expect((readTraces(cancelled.headers.get('x-openselect-request-id')!).traces[0] as any).state).toBe('cancelled');
  const badStream=await withRequestTrace(new Request('http://local/v1/messages',{method:'POST'}),async()=>new Response('data: {"type":"error","error":{"type":"api_error"}}\n\n',{headers:{'content-type':'text/event-stream'}}));
  await badStream.text();expect((readTraces(badStream.headers.get('x-openselect-request-id')!).traces[0] as any).state).toBe('failed');
 }finally{upstream.stop(true);}
}
if(mode==='routing'){
 const nowOriginal=Date.now;let now=nowOriginal();Date.now=()=>now;
 try{
 cfg.policy.codingAutoOrder=['minimax','opencode'];cfg.accounts=[{id:'r-mm',label:'m',integration:'minimax',key:'dummy',enabled:true,addedAt:0},{id:'r-open',label:'o',integration:'opencode-go',key:'dummy',enabled:true,addedAt:0}];
 const rt=new Runtime(cfg,catalog),requirements=requestRequirements({thinking:{type:'disabled'}});
 expect(buildRoutingPlan(rt,requirements).selectedRoute).toBe('opencode');
 const profile=clientModelProfile(rt);expect(profile.contextWindow).toBe(1000000);expect(profile.maxTokens).toBe(32768);
 const seed=(provider:string,wait:number)=>{for(let n=0;n<5;n++){const id=crypto.randomUUID();getDb().query("INSERT INTO request_traces(id,started_at,state,status,duration_ms,attempts,final_provider,generation_ms) VALUES (?,?,'complete',200,100,1,?,50)").run(id,now,provider);getDb().query('INSERT INTO request_attempts(trace_id,ordinal,started_at,provider,model,header_status,header_ms) VALUES (?,1,?,?,?,200,?)').run(id,now,provider,provider==='opencode-go'?'deepseek-v4.1-flash':'MiniMax-M3.1-Flash',wait);}};
 seed('opencode-go',50);seed('minimax',1000);
 cfg.policy.routingMode='speed';
 const plain=requestRequirements({});
 const before=JSON.stringify([...rt.states]);const snapshots=getDb().query('SELECT total_changes() n').get() as any;
 expect(buildRoutingPlan(rt,plain).selectedRoute).toBe('opencode');
 expect(JSON.stringify([...rt.states])).toBe(before);expect((getDb().query('SELECT total_changes() n').get() as any).n).toBe(snapshots.n);
 buildRoutingPlan(rt,plain,'other',null,true);
 getDb().query("UPDATE request_attempts SET header_ms=CASE WHEN provider='minimax' THEN 1 ELSE 1000 END").run();
 now+=31000;const held=buildRoutingPlan(rt,plain,'other',null,true);expect(held.held).toBe(true);expect(held.selectedRoute).toBe('opencode');
 now+=31000;expect(buildRoutingPlan(rt,plain,'other',null,true).selectedRoute).toBe('minimax');
 cfg.accounts[0].enabled=false;expect(buildRoutingPlan(rt,plain,'other',null,true).selectedRoute).toBe('opencode');
 }finally{Date.now=nowOriginal;}
}
if(mode==='keychain'){
 let secret='',writes=0;const argsSeen:string[][]=[];
 const backend=(args:string[],input?:string)=>{
  argsSeen.push(args);
  if(args[0]==='find-generic-password')return {status:secret?0:44,stdout:secret};
  writes++;expect(args).toEqual(['-i','-q']);expect(input).not.toContain('-A');secret=input!.match(/-w ([0-9a-f]{64})/)![1]!;return {status:0,stdout:''};
 };
 expect(ensureBackupKeychain(backend).created).toBe(true);expect(writes).toBe(1);
 expect(argsSeen.some(a=>a.some(value=>value.includes(secret)))).toBe(false);
 expect(ensureBackupKeychain(backend).created).toBe(false);expect(writes).toBe(1);
 expect(()=>ensureBackupKeychain(()=>({status:36,stdout:''}))).toThrow();
}
