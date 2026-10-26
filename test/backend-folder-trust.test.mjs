import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trustFolder} from '../backend/actions.mjs';
import {createStore,applyStateChange} from '../backend/store.mjs';
import {createAttention,addItem} from '../backend/attention.mjs';
import {parseCodexPrompt,promptHash} from '../backend/notify.mjs';
import {makeFakeApi,CODEX_FOLDER_TRUST} from './backend-fake-api.mjs';
async function setup(){
 const api=makeFakeApi({panes:[{id:'p',type:'shell',workspaceID:'ws',status:'idle'}]});const store=createStore(api);const att=createAttention(api,store);
 applyStateChange(store,{kind:'pane-upserted',paneID:'p',workspaceID:'ws',pane:{id:'p',type:'shell',status:'idle'}});
 const prompt=parseCodexPrompt(CODEX_FOLDER_TRUST);const hash=promptHash(prompt.block);
 const {item}=await addItem(att,{type:'Request',paneID:'p',agent:'codex',approvable:false,promptBlock:prompt.block,promptHash:hash});
 api.terminal.read=async()=>({text:CODEX_FOLDER_TRUST,revision:42,altScreen:true});
 return{api,store,item,args:{itemID:item.id,promptHash:hash,confirm:true}};
}
test('folder trust requires explicit confirmation and sends one revision-guarded Enter to only that pane',async()=>{
 const {api,store,item,args}=await setup();
 assert.deepEqual(await trustFolder(api,store,{...args,confirm:false}),{ok:false,error:'Confirm lasting repository trust before continuing.',code:'CONFIRM_REQUIRED'});
 assert.deepEqual(api.callsTo('terminal.sendKey'),[]);assert.equal(item.handledAt,undefined);
 assert.deepEqual(await trustFolder(api,store,args),{ok:true,itemID:item.id,paneID:'p'});
 assert.deepEqual(api.callsTo('terminal.sendKey').map(c=>c.args),[['p','enter',{ifRevision:42}]]);
 assert.ok(item.handledAt);
 assert.deepEqual(await trustFolder(api,store,args),{ok:false,error:'This folder trust request is no longer waiting.',code:'STALE'});
 assert.equal(api.callsTo('terminal.sendKey').length,1);
});
test('changed folders, a selected Quit, missing revisions and normal shells never receive a trust key',async()=>{
 for(const read of [{text:CODEX_FOLDER_TRUST.replace('/repos/worktree','/another/repo'),revision:42,altScreen:true},{text:CODEX_FOLDER_TRUST.replace('› 1.','1.').replace('  2.','› 2.'),revision:42,altScreen:true},{text:CODEX_FOLDER_TRUST,altScreen:true},{text:'$',revision:42,altScreen:false}]){
  const {api,store,item,args}=await setup();api.terminal.read=async()=>read;
  assert.deepEqual(await trustFolder(api,store,args),{ok:false,error:'The folder trust prompt changed; review the current card or open the pane.',code:'STALE'});
  assert.deepEqual(api.callsTo('terminal.sendKey'),[]);assert.equal(item.handledAt,undefined);
 }
});
test('a failed guarded send keeps folder trust pending',async()=>{
 const {api,store,item,args}=await setup();api.terminal.sendKey=async()=>{throw Error('screen changed');};
 assert.deepEqual(await trustFolder(api,store,args),{ok:false,error:'Folder trust was not sent: screen changed',code:'SEND_FAILED'});assert.equal(item.handledAt,undefined);
});
