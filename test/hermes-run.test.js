const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createRun}=require('../lib/hermes-run');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const frame=data=>`data: ${JSON.stringify(data)}\n\n`;
async function setup(t,{stopStatus=200,delay=0}={}) {
  const calls=[];let stream;
  const server=http.createServer((req,res)=>{
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      calls.push({path:req.url,method:req.method,body:raw?JSON.parse(raw):null,auth:req.headers.authorization,key:req.headers['idempotency-key']});
      if(req.url.endsWith('/stop')) {res.writeHead(stopStatus);res.end(JSON.stringify({status:'stopping'}));if(stopStatus===200&&stream)stream.end(frame({event:'run.cancelled',run_id:'r1'}));return;}
      if(req.method==='POST'){setTimeout(()=>{res.writeHead(202);res.end('{"run_id":"r1","status":"started"}');},delay);return;}
      stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write(frame({event:'run.queued',run_id:'r1'}));
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.close();server.closeAllConnections();});
  return {opts:{hermesPort:server.address().port,hermesKey:'health-key',hermesPathPrefix:'/p/health'},calls,
    emit:async data=>{for(let i=0;!stream&&i<50;i++)await sleep(5);assert.ok(stream);stream.write(frame(data));},
    end:()=>stream&&stream.end()};
}
test('native runs preserve instructions, session, scoped auth and precise progress',async t=>{
 const s=await setup(t),progress=[],approvals=[];
 const run=createRun(s.opts,'watch-session','stable system','spoken text\nclock',x=>approvals.push(x),x=>progress.push(x));
 await s.emit({event:'tool.started',tool:'mcp__nutritrace__log_food',preview:'private details'});
 await s.emit({event:'approval.request',run_id:'r1',prompt_id:'p1',command:'Approve?'});
 await s.emit({event:'message.delta',delta:'partial'});
 await s.emit({event:'run.completed',output:'verified final'});
 assert.equal((await run.promise).text,'verified final');
 assert.ok(progress.includes('Saving food entry'));
 assert.ok(!progress.some(x=>x.includes('private')));
 assert.equal(approvals[0].request_id,'p1');
 assert.equal(approvals[0].run_id,'r1');
 assert.equal(s.calls[0].path,'/p/health/v1/runs');
 assert.equal(s.calls[0].body.instructions,'stable system');
 assert.equal(s.calls[0].body.session_id,'watch-session');
 assert.equal(s.calls[0].body.input,'spoken text\nclock');
 assert.ok(s.calls[0].key);assert.equal(s.calls[0].auth,'Bearer health-key');
});
test('native Stop uses the durable run endpoint and settles its result',async t=>{
 const s=await setup(t);const run=createRun(s.opts,'s','system','question',()=>{},()=>{});
 await s.emit({event:'message.delta',delta:'still running'});
 assert.equal(await run.stop(),200);assert.equal((await run.promise).status,499);
 assert.equal(s.calls.find(c=>c.path.endsWith('/stop')).path,'/p/health/v1/runs/r1/stop');
});
test('Stop before admission waits for its run ID and never opens an observer',async t=>{
 const s=await setup(t,{delay:30});const run=createRun(s.opts,'s','system','question',()=>{},()=>{});
 assert.equal(await run.stop(),200);await run.promise;
 assert.equal(s.calls.filter(c=>c.method==='GET').length,0);
});
test('failed native Stop is reported and the run can still finish',async t=>{
 const s=await setup(t,{stopStatus:503});const run=createRun(s.opts,'s','system','question',()=>{},()=>{});
 await s.emit({event:'message.delta',delta:'x'});
 assert.equal(await run.stop(),503);
 await s.emit({event:'run.completed',output:'finished after failed Stop'});
 assert.equal((await run.promise).text,'finished after failed Stop');
});
