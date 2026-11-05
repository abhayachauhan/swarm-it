import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCodexPrompt, onNotification} from '../backend/notify.mjs';
import {answerNativeQuestion} from '../backend/actions.mjs';
import {createStore, applyStateChange} from '../backend/store.mjs';
import {createAttention} from '../backend/attention.mjs';
import {makeFakeApi} from './backend-fake-api.mjs';
const screen = (selected=0, question='Permit exactly three recorded version checks?') => `• Working (35m • esc to interrupt)\n• Queued follow-up inputs\n\n1 of 2\n${question}\n${selected===0?'›':' '} 1. Permit three recorded version checks\n${selected===1?'›':' '} 2. Use prepared frontend builds\n  3. Other\n\nenter submit   ^J skip   ⇧→ main prompt\n⇧← next question`;
async function setup() {
 const api=makeFakeApi({captures:{p:screen()}}), store=createStore(api);createAttention(api,store);
 applyStateChange(store,{kind:'pane-upserted',paneID:'p',pane:{id:'p',type:'shell',agent:'codex',workspaceID:'ws1'}});
 const {item}=await onNotification(api,store,store.att,{data:{paneID:'p',title:'Codex'}});
 assert.deepEqual(item.nativeQuestion,{options:['Permit three recorded version checks','Use prepared frontend builds','Other']});
 return {api,store,item,args:{itemID:item.id,promptHash:item.promptHash,option:1}};
}
test('expanded wrapped Codex question has its real choices, not an unparsed waiting card',()=>{
 const parsed=parseCodexPrompt(screen().replace('Permit exactly three','Permit exactly\nthree'));
 assert.equal(parsed.question,'Permit exactly three recorded version checks?');
 assert.equal(parsed.selected,0);assert.equal(parsed.counter,'1 of 2');
 assert.deepEqual(parsed.options,['Permit three recorded version checks','Use prepared frontend builds','Other']);
 assert.equal(parseCodexPrompt(screen().replace('enter submit','other output')),null);
});
test('explicit choice navigates then submits with revision guards and settles only that card',async()=>{
 const {api,store,item,args}=await setup();let selected=0,revision=3;const keys=[];
 api.terminal.read=async()=>({text:screen(selected),altScreen:true,revision});
 api.terminal.sendKey=async(p,key,options)=>{assert.equal(p,'p');assert.deepEqual(options,{ifRevision:revision});keys.push(key);selected=1;revision++;};
 assert.deepEqual(await answerNativeQuestion(api,store,args),{ok:true});
 assert.deepEqual(keys,['down','enter']);assert.ok(item.handledAt);
});
test('changed question, missing revision and custom choice never send keys or settle a card',async()=>{
 for(const mode of ['changed','revision','custom']){
  const {api,store,item,args}=await setup();api.terminal.read=async()=>({text:screen(0,mode==='changed'?'Different question?':'Permit exactly three recorded version checks?'),altScreen:true,revision:mode==='revision'?undefined:5});
  if(mode==='custom')args.option=2;
  const result=await answerNativeQuestion(api,store,args);
  assert.equal(result.code,mode==='custom'?'CUSTOM_ANSWER':'STALE');assert.equal(item.handledAt,undefined);assert.equal(api.callsTo('terminal.sendKey').length,0);
 }
});
test('question changing after navigation cannot receive Enter',async()=>{
 const {api,store,item,args}=await setup();let changed=false;const keys=[];
 api.terminal.read=async()=>({text:screen(0,changed?'Different question?':'Permit exactly three recorded version checks?'),altScreen:true,revision:5});
 api.terminal.sendKey=async(p,key)=>{keys.push(key);changed=true;};
 assert.equal((await answerNativeQuestion(api,store,args)).code,'STALE');assert.deepEqual(keys,['down']);assert.equal(item.handledAt,undefined);
});
test('revision rejection retains the unanswered card and sends no further key',async()=>{
 const {api,store,item,args}=await setup();const keys=[];
 api.terminal.read=async()=>({text:screen(),altScreen:true,revision:5});
 api.terminal.sendKey=async(p,key)=>{keys.push(key);throw new Error('revision changed');};
 assert.deepEqual(await answerNativeQuestion(api,store,args),{ok:false,error:'Answer was not confirmed: revision changed',code:'SEND_FAILED'});
 assert.deepEqual(keys,['down']);assert.equal(item.handledAt,undefined);
});
