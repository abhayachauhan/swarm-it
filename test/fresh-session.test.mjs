import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshSession} from '../backend/fresh-session.mjs';
import {makeFakeApi} from './backend-fake-api.mjs';
const id='11111111-2222-4333-8444-555555555555';
const empty='────────────────────────────────────────────────────────────\n❯\n────────────────────────────────────────────────────────────';
const summary={goal:'Test a fixed server action key',now:'Not started; compaction limit',next:'Run the pre-fix reproduction.',needsYou:'',steps:[]};
function setup(){
 const api=makeFakeApi({panes:[{id:'source',agent:'claude',agentSessionID:id,type:'shell',workspaceID:'ws1',status:'idle',workingDirectory:'/tmp/repo'}],captures:{source:empty}});let saved,restarted;
 const options={home:'/tmp/fresh-home',root:'/tmp/handoffs',readdir:async()=>[`${id}.jsonl`],stat:async()=>({isFile:()=>true,size:20,mtimeMs:1}),mkdir:async()=>{},writeFile:async(path,text,flags)=>{saved={path,text,flags};},readMessages:async()=>({messages:[{role:'user',text:'Run ~/repos/plans/swarm/fixed-key/plan.md'},{role:'assistant',text:'Compaction limit. No builds or workers started.'}]}),generate:async(input,config)=>{assert.ok(config.timeoutMs<=10000);return summary;},restart:async(a,s,p,deps)=>{restarted={p,deps};return {result:{ok:true,restarting:true},finished:Promise.resolve({ok:true,paneID:p})};}};
 return {api,options,saved:()=>saved,restarted:()=>restarted};
}
test('compaction-limit continuation preserves the original plan without relying on the model to repeat it',async()=>{
 const {api,options,saved,restarted}=setup();const result=await freshSession(api,{settings:{}},{paneID:'source'},{},options);
 assert.equal(result.ok,true);assert.match(saved().text,/No builds or workers started/);assert.match(saved().text,/fixed-key\/plan.md/);assert.deepEqual(saved().flags,{flag:'wx',mode:0o600});
 assert.equal(restarted().p,'source');assert.equal(restarted().deps.fresh.path,saved().path);assert.equal(restarted().deps.fresh.session,id);assert.equal(restarted().deps.fresh.agent,'claude');assert.equal(await restarted().deps.fresh.unchanged(),true);
 assert.equal(api.callsTo('panes.split').length,0);assert.equal(api.callsTo('panes.close').length,0);
});
test('summary failure leaves the source unchanged',async()=>{
 const {api,options,restarted}=setup();options.generate=async()=>{throw new Error('usage limit');};
 assert.deepEqual(await freshSession(api,{settings:{}},{paneID:'source'},{},options),{ok:false,code:'FRESH_FAILED',error:'Could not continue in a fresh session: usage limit'});
 assert.equal(restarted(),undefined);assert.equal(api.captureStore.source,empty);assert.equal(api.callsTo('terminal.send').length,0);
});
test('draft, busy session and background agents never start the summary or restart',async()=>{
 for(const mode of ['draft','busy','background']){
  const {api,options,restarted}=setup();let generated=false;options.generate=async()=>{generated=true;return summary;};
  if(mode==='draft')api.captureStore.source=empty.replace('❯','❯ unfinished');
  if(mode==='busy')await api.upsert('source',{status:'running'});
  if(mode==='background')api.captureStore.source=empty+'\n1 background agent running';
  const result=await freshSession(api,{settings:{}},{paneID:'source'},{},options);
  assert.equal(result.code,{draft:'INPUT_NOT_EMPTY',busy:'BUSY',background:'BACKGROUND'}[mode]);assert.equal(generated,false);assert.equal(restarted(),undefined);assert.equal(api.callsTo('terminal.send').length,0);
 }
});
test('a transcript changed during summary generation stays open without restarting',async()=>{
 const {api,options,restarted}=setup();let version=1;options.stat=async()=>({isFile:()=>true,size:20,mtimeMs:version});options.generate=async()=>{version++;return summary;};
 assert.deepEqual(await freshSession(api,{settings:{}},{paneID:'source'},{},options),{ok:false,code:'SESSION_CHANGED',error:'The source changed while summarising; try again when idle.'});assert.equal(restarted(),undefined);assert.equal(api.captureStore.source,empty);
});
test('a repeated button click cannot start two summaries',async()=>{
 const {api,options}=setup();let release;const waiting=new Promise(resolve=>{release=resolve;});options.generate=async()=>{await waiting;return summary;};
 const first=freshSession(api,{settings:{}},{paneID:'source'},{},options);
 assert.deepEqual(await freshSession(api,{settings:{}},{paneID:'source'},{},options),{ok:false,code:'IN_PROGRESS',error:'A fresh-session request is already running for this pane.'});release();assert.equal((await first).ok,true);
});
test('native large JSON rows retain the actual latest text instead of an old head-only summary',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {transcriptMessages}=await import('../backend/workspace-brief.mjs');
 const dir=await mkdtemp(join(tmpdir(),'fresh-transcript-'));
 try{
  const path=join(dir,'session.jsonl');await writeFile(path,[JSON.stringify({type:'user',message:{content:'Run ~/repos/plans/swarm/fixed-key/plan.md'}}),JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'No builds or workers started. Continue from the saved plan.'}]},nativeState:'x'.repeat(400000)}),JSON.stringify({type:'system',subtype:'turn_duration'})].join('\n')+'\n');
  const loaded=await transcriptMessages(path,'claude');assert.ok(loaded.tailCount>0);assert.equal(loaded.messages.at(-1).text,'No builds or workers started. Continue from the saved plan.');assert.ok(loaded.planPaths.includes('~/repos/plans/swarm/fixed-key/plan.md'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('workers from the followed swarm or another swarm are never reset',async()=>{
 for(const state of [{manifestWorkers:[{paneID:'source'}]},{swarms:[{workers:[{paneID:'source'}]}]}]){
  const {api,options,restarted}=setup();
  assert.deepEqual(await freshSession(api,{settings:{},...state},{paneID:'source'},{},options),{ok:false,error:'Finish or stop this worker before starting a fresh conversation.',code:'WORKER'});assert.equal(restarted(),undefined);assert.equal(api.callsTo('terminal.send').length,0);
 }
});
